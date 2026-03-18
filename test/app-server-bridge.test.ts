import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("node-pty", () => ({
  spawn: vi.fn(),
}));

let mockLocalThreadListData: unknown[] = [];
const mockLocalRequestErrors = new Map<string, string>();
const tempDirs: string[] = [];
const mockPtys: MockPty[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalShell = process.env.SHELL;
const TEST_WORKSPACE_ROOT = process.cwd();
const TEST_PROJECT_ALPHA_ROOT = join(TEST_WORKSPACE_ROOT, "..", "project-alpha");
const TEST_PROJECT_BETA_ROOT = join(TEST_WORKSPACE_ROOT, "..", "project-beta");
const TEST_NOT_AUTO_ADDED_ROOT = join(TEST_WORKSPACE_ROOT, "..", "not-auto-added");
const TEST_MISSING_ROOT = join(TEST_WORKSPACE_ROOT, "..", "definitely-missing-path");
const TEST_PUBLIC_ORIGIN_URL = "https://github.com/davej/pocodex.git";

class FakeGitWorkerBridge extends EventEmitter {
  readonly sentMessages: unknown[] = [];
  readonly subscriptions: string[] = [];
  closeCalls = 0;

  async send(message: unknown): Promise<void> {
    this.sentMessages.push(message);
  }

  async subscribe(): Promise<void> {
    this.subscriptions.push("subscribe");
  }

  async unsubscribe(): Promise<void> {
    this.subscriptions.push("unsubscribe");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  writes = "";
  private stdinBuffer = "";

  constructor() {
    super();

    this.stdin.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.writes += text;

      this.stdinBuffer += text;
      const lines = this.stdinBuffer.split("\n");
      this.stdinBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const message = JSON.parse(line) as {
          id?: string | number;
          method?: string;
        };
        if (
          String(message.id ?? "").startsWith("pocodex-local-") &&
          message.method === "initialize"
        ) {
          setImmediate(() => {
            this.stdout.write(
              `${JSON.stringify({
                id: message.id,
                result: {
                  ok: true,
                },
              })}\n`,
            );
          });
        }

        if (
          String(message.id ?? "").startsWith("pocodex-local-") &&
          message.method === "config/read"
        ) {
          setImmediate(() => {
            this.stdout.write(
              `${JSON.stringify({
                id: message.id,
                result: {
                  ok: true,
                },
              })}\n`,
            );
          });
        }

        if (
          String(message.id ?? "").startsWith("pocodex-local-") &&
          message.method === "thread/list"
        ) {
          setImmediate(() => {
            this.stdout.write(
              `${JSON.stringify({
                id: message.id,
                result: {
                  data: mockLocalThreadListData,
                  nextCursor: null,
                },
              })}\n`,
            );
          });
        }

        if (
          String(message.id ?? "").startsWith("pocodex-local-") &&
          (message.method === "thread/archive" || message.method === "thread/unarchive")
        ) {
          setImmediate(() => {
            const errorMessage = mockLocalRequestErrors.get(message.method);
            this.stdout.write(
              `${JSON.stringify({
                id: message.id,
                ...(errorMessage
                  ? {
                      error: {
                        message: errorMessage,
                      },
                    }
                  : {
                      result: {
                        ok: true,
                      },
                    }),
              })}\n`,
            );
          });
        }
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }
}

class MockPty {
  readonly pid = 1234;
  cols: number;
  rows: number;
  readonly process: string;
  handleFlowControl = false;
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly file: string;
  readonly args: string[] | string;
  readonly options: Record<string, unknown>;
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();

  constructor(file: string, args: string[] | string, options: Record<string, unknown>) {
    this.file = file;
    this.args = args;
    this.options = options;
    this.cols = Number(options.cols ?? 80);
    this.rows = Number(options.rows ?? 24);
    this.process = file.split("/").pop() ?? file;
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  clear(): void {}

  write(data: string | Buffer): void {
    this.writes.push(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  }

  kill(): void {
    this.killed = true;
  }

  pause(): void {}

  resume(): void {}

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode, signal });
    }
  }
}

describe("AppServerBridge", () => {
  const children: MockChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (!child.killed) {
        child.kill();
      }
    }
    for (const directory of tempDirs.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    mockLocalThreadListData = [];
    mockLocalRequestErrors.clear();
    mockPtys.length = 0;
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    process.env.SHELL = originalShell;
    vi.clearAllMocks();
  });

  it("initializes the codex app-server and forwards MCP traffic", async () => {
    const bridge = await createBridge(children);

    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "ready",
    });

    const child = children.at(0);
    expect(child).toBeTruthy();
    const written = child?.writes ?? "";
    expect(written).toContain('"method":"initialize"');
    expect(written).toContain('"method":"initialized"');

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-1",
        method: "thread/list",
        params: {
          limit: 10,
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"id":"req-1"');
    expect(forwarded).toContain('"method":"thread/list"');

    child?.stdout.write(
      `${JSON.stringify({
        id: "req-1",
        result: {
          data: [],
        },
      })}\n`,
    );

    await waitForCondition(() => emittedMessages.length >= 3);

    expect(emittedMessages).toEqual([
      {
        type: "codex-app-server-connection-changed",
        hostId: "local",
        state: "connected",
        transport: "websocket",
      },
      {
        type: "codex-app-server-initialized",
        hostId: "local",
      },
      {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "req-1",
          result: {
            data: [],
          },
        },
      },
    ]);

    await bridge.close();
  });

  it("implements host fetch state for pinned threads and global state", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-1",
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "thread-titles" }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-2",
      method: "POST",
      url: "vscode://codex/set-thread-pinned",
      body: JSON.stringify({ threadId: "thr_123", pinned: true }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-3",
      method: "POST",
      url: "vscode://codex/list-pinned-threads",
    });

    await waitForCondition(() => emittedMessages.length >= 4);

    expect(getFetchResponse(emittedMessages, "fetch-1")).toEqual({
      type: "fetch-response",
      requestId: "fetch-1",
      responseType: "success",
      status: 200,
      headers: {
        "content-type": "application/json",
      },
      bodyJsonString: JSON.stringify({
        value: {},
      }),
    });

    expect(emittedMessages).toContainEqual({
      type: "pinned-threads-updated",
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-3")).toEqual({
      threadIds: ["thr_123"],
    });

    await bridge.close();
  });

  it("publishes shared object updates and workspace bootstrap responses", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "shared-object-subscribe",
      key: "host_config",
    });

    await bridge.forwardBridgeMessage({
      type: "electron-onboarding-pick-workspace-or-create-default",
      defaultProjectName: "Playground",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-1",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-2",
      method: "POST",
      url: "vscode://codex/workspace-root-options",
    });

    await waitForCondition(() =>
      emittedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          "requestId" in message &&
          message.type === "fetch-response" &&
          message.requestId === "fetch-2",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "shared-object-updated",
      key: "host_config",
      value: {
        id: "local",
        display_name: "Local",
        kind: "local",
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-1")).toEqual({
      roots: [],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-2")).toEqual({
      roots: [],
      labels: {},
    });

    await bridge.close();
  });

  it("creates on attach, ignores early resize, and rebinds terminal sessions by conversation", async () => {
    process.env.SHELL = "/bin/zsh";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-resize",
      sessionId: "missing-before-attach",
      cols: 120,
      rows: 40,
    });

    expect(emittedMessages).toEqual([]);

    await bridge.forwardBridgeMessage({
      type: "terminal-attach",
      sessionId: "term-1",
      conversationId: "conv-1",
      cwd: TEST_WORKSPACE_ROOT,
      cols: 120,
      rows: 40,
    });

    expect(mockPtys).toHaveLength(1);
    expect(mockPtys[0]?.file).toBe("/bin/zsh");
    expect(emittedMessages).toContainEqual({
      type: "terminal-attached",
      sessionId: "term-1",
      cwd: TEST_WORKSPACE_ROOT,
      shell: "/bin/zsh",
    });

    mockPtys[0]?.emitData("prompt> ");
    await waitForCondition(() =>
      emittedMessages.some(
        (message) => isBridgeMessage(message, "terminal-data") && message.sessionId === "term-1",
      ),
    );

    emittedMessages.length = 0;

    await bridge.forwardBridgeMessage({
      type: "terminal-attach",
      sessionId: "term-2",
      conversationId: "conv-1",
      cwd: TEST_WORKSPACE_ROOT,
      cols: 100,
      rows: 30,
    });

    expect(mockPtys).toHaveLength(1);
    expect(mockPtys[0]?.resizeCalls.at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(emittedMessages).toContainEqual({
      type: "terminal-init-log",
      sessionId: "term-2",
      log: "prompt> ",
    });
    expect(emittedMessages).toContainEqual({
      type: "terminal-attached",
      sessionId: "term-2",
      cwd: TEST_WORKSPACE_ROOT,
      shell: "/bin/zsh",
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-write",
      sessionId: "term-2",
      data: "pwd\n",
    });

    expect(mockPtys[0]?.writes.at(-1)).toBe("pwd\n");

    await bridge.close();
  });

  it("writes, runs actions, resizes, and reports terminal errors", async () => {
    process.env.SHELL = "/bin/zsh";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-create",
      sessionId: "term-2",
      conversationId: "conv-2",
      cwd: TEST_WORKSPACE_ROOT,
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-write",
      sessionId: "term-2",
      data: "ls\n",
    });
    await bridge.forwardBridgeMessage({
      type: "terminal-run-action",
      sessionId: "term-2",
      cwd: TEST_WORKSPACE_ROOT,
      command: "pwd",
    });
    await bridge.forwardBridgeMessage({
      type: "terminal-resize",
      sessionId: "term-2",
      cols: 140,
      rows: 50,
    });
    await bridge.forwardBridgeMessage({
      type: "terminal-write",
      sessionId: "missing-session",
      data: "noop",
    });

    expect(mockPtys[0]?.writes).toEqual([`ls\n`, `cd '${TEST_WORKSPACE_ROOT}' && pwd\n`]);
    expect(mockPtys[0]?.resizeCalls.at(-1)).toEqual({ cols: 140, rows: 50 });
    expect(emittedMessages).toContainEqual({
      type: "terminal-error",
      sessionId: "missing-session",
      message: "Terminal session is not available.",
    });

    await bridge.close();
  });

  it("force-syncs cwd, emits exit, and disposes terminal sessions on bridge close", async () => {
    process.env.SHELL = "/bin/zsh";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-terminal-cwd-"));
    tempDirs.push(tempDirectory);

    await bridge.forwardBridgeMessage({
      type: "terminal-create",
      sessionId: "term-3",
      conversationId: "conv-3",
      cwd: TEST_WORKSPACE_ROOT,
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-attach",
      sessionId: "term-3",
      conversationId: "conv-3",
      cwd: tempDirectory,
      forceCwdSync: true,
    });

    expect(mockPtys[0]?.writes.at(-1)).toBe(`cd '${tempDirectory}'\n`);
    expect(emittedMessages).toContainEqual({
      type: "terminal-attached",
      sessionId: "term-3",
      cwd: tempDirectory,
      shell: "/bin/zsh",
    });

    emittedMessages.length = 0;
    mockPtys[0]?.emitExit(17);

    await waitForCondition(() =>
      emittedMessages.some(
        (message) => isBridgeMessage(message, "terminal-exit") && message.sessionId === "term-3",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "terminal-exit",
      sessionId: "term-3",
      code: 17,
      signal: null,
    });

    emittedMessages.length = 0;

    await bridge.forwardBridgeMessage({
      type: "terminal-create",
      sessionId: "term-4",
      conversationId: "conv-4",
      cwd: TEST_WORKSPACE_ROOT,
    });

    expect(mockPtys[1]?.killed).toBe(false);
    await bridge.close();
    expect(mockPtys[1]?.killed).toBe(true);
    expect(emittedMessages).not.toContainEqual(
      expect.objectContaining({
        type: "terminal-exit",
        sessionId: "term-4",
      }),
    );
  });

  it("opens the desktop import dialog for add-project host actions", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "electron-add-new-workspace-root-option",
    });

    expect(emittedMessages).toContainEqual({
      type: "pocodex-open-desktop-import-dialog",
      mode: "manual",
    });

    await bridge.close();
  });

  it("does not emit a top-level error when archiving a thread fails", async () => {
    mockLocalRequestErrors.set("thread/archive", "Thread not found");
    const bridge = await createBridge(children);
    const errors: Error[] = [];
    bridge.on("error", (error) => {
      errors.push(error);
    });

    await bridge.forwardBridgeMessage({
      type: "archive-thread",
      conversationId: "thr_test",
      requestId: "archive-1",
    });

    await waitForCondition(() =>
      (children.at(-1)?.writes ?? "").includes('"method":"thread/archive"'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([]);

    await bridge.close();
  });

  it("resolves archive requests for the desktop webview after archiving succeeds", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "archive-thread",
      conversationId: "thr_test",
      requestId: "archive-1",
    });

    await waitForCondition(() =>
      emittedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: unknown }).type === "serverRequest/resolved",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "serverRequest/resolved",
      params: {
        threadId: "thr_test",
        requestId: "archive-1",
      },
    });

    await bridge.close();
  });

  it("handles archive mcp requests locally for the desktop webview", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const child = children.at(-1);
    const writesBefore = child?.writes ?? "";

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-archive-1",
        method: "thread/archive",
        params: {
          threadId: "thr_test",
        },
      },
    });

    await waitForCondition(() =>
      emittedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: unknown }).type === "mcp-response",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: "req-archive-1",
        result: {
          ok: true,
        },
      },
    });
    expect((child?.writes ?? "").slice(writesBefore.length)).not.toContain('"id":"req-archive-1"');
    expect((child?.writes ?? "").slice(writesBefore.length)).not.toContain(
      '"method":"thread/archive"',
    );

    await bridge.close();
  });

  it("treats a missing workspace registry as pristine with no projects", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    mockLocalThreadListData = [
      {
        id: "thr_a",
        cwd: TEST_PROJECT_ALPHA_ROOT,
      },
      {
        id: "thr_b",
        cwd: TEST_PROJECT_BETA_ROOT,
      },
    ];

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-active-roots",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-root-options",
      method: "POST",
      url: "vscode://codex/workspace-root-options",
    });

    await waitForCondition(() => emittedMessages.length >= 2);

    expect(getFetchJsonBody(emittedMessages, "fetch-active-roots")).toEqual({
      roots: [],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-root-options")).toEqual({
      roots: [],
      labels: {},
    });

    expect(children.at(-1)?.writes ?? "").not.toContain('"method":"thread/list"');

    await bridge.close();
  });

  it("persists workspace roots, labels, and active project across restarts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");

    const firstBridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });

    await firstBridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-add-root",
      method: "POST",
      url: "vscode://codex/add-workspace-root-option",
      body: JSON.stringify({
        root: TEST_PROJECT_ALPHA_ROOT,
        setActive: false,
      }),
    });

    await firstBridge.forwardBridgeMessage({
      type: "electron-rename-workspace-root-option",
      root: TEST_PROJECT_ALPHA_ROOT,
      label: "Project Alpha",
    });

    await firstBridge.forwardBridgeMessage({
      type: "electron-update-workspace-root-options",
      roots: [TEST_PROJECT_ALPHA_ROOT, TEST_WORKSPACE_ROOT],
    });

    await firstBridge.forwardBridgeMessage({
      type: "electron-set-active-workspace-root",
      root: TEST_PROJECT_ALPHA_ROOT,
    });

    await firstBridge.close();

    mockLocalThreadListData = [
      {
        id: "thr_new",
        cwd: TEST_NOT_AUTO_ADDED_ROOT,
      },
    ];

    const secondBridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    secondBridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await secondBridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-active-roots",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await secondBridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-root-options",
      method: "POST",
      url: "vscode://codex/workspace-root-options",
    });

    await waitForCondition(() => emittedMessages.length >= 2);

    expect(getFetchJsonBody(emittedMessages, "fetch-active-roots")).toEqual({
      roots: [TEST_PROJECT_ALPHA_ROOT, TEST_WORKSPACE_ROOT],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-root-options")).toEqual({
      roots: [TEST_PROJECT_ALPHA_ROOT, TEST_WORKSPACE_ROOT],
      labels: {
        [TEST_PROJECT_ALPHA_ROOT]: "Project Alpha",
        [TEST_WORKSPACE_ROOT]: "pocodex",
      },
    });

    await secondBridge.close();
  });

  it("persists host persisted atoms across restarts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-persisted-atoms-"));
    tempDirs.push(tempDirectory);
    const persistedAtomRegistryPath = join(tempDirectory, "persisted-atoms.json");

    const firstBridge = await createBridge(children, {
      persistedAtomRegistryPath,
    });

    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "agent-mode",
      value: "full-access",
    });
    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "skip-full-access-confirm",
      value: true,
    });
    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "transient-key",
      value: "stale",
    });
    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "transient-key",
      deleted: true,
    });

    await firstBridge.close();

    await expect(readFile(persistedAtomRegistryPath, "utf8")).resolves.toContain(
      '"agent-mode": "full-access"',
    );
    await expect(readFile(persistedAtomRegistryPath, "utf8")).resolves.not.toContain(
      '"transient-key"',
    );

    const secondBridge = await createBridge(children, {
      persistedAtomRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    secondBridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await secondBridge.forwardBridgeMessage({
      type: "persisted-atom-sync-request",
    });

    await waitForCondition(() => emittedMessages.length >= 1);

    expect(emittedMessages).toContainEqual({
      type: "persisted-atom-sync",
      state: {
        "agent-mode": "full-access",
        "skip-full-access-confirm": true,
      },
    });

    await secondBridge.close();
  });

  it("lists Codex desktop projects for import through IPC", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-import-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const importedProjectRoot = join(tempDirectory, "imported-project");
    const codexDesktopGlobalStatePath = await writeDesktopGlobalState(tempDirectory, {
      roots: [TEST_WORKSPACE_ROOT, importedProjectRoot],
      activeRoots: [importedProjectRoot],
      labels: {
        [importedProjectRoot]: "Imported Project",
      },
    });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
      codexDesktopGlobalStatePath,
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-1",
        method: "desktop-workspace-import/list",
      }),
    ).resolves.toEqual({
      requestId: "ipc-1",
      type: "response",
      resultType: "success",
      result: {
        found: true,
        path: codexDesktopGlobalStatePath,
        promptSeen: false,
        shouldPrompt: true,
        projects: [
          {
            root: TEST_WORKSPACE_ROOT,
            label: "pocodex",
            activeInCodex: false,
            alreadyImported: false,
            available: true,
          },
          {
            root: importedProjectRoot,
            label: "Imported Project",
            activeInCodex: true,
            alreadyImported: false,
            available: true,
          },
        ],
      },
    });

    await bridge.close();
  });

  it("imports selected Codex desktop projects and persists prompt dismissal", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-import-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const importedProjectRoot = join(tempDirectory, "imported-project");
    const codexDesktopGlobalStatePath = await writeDesktopGlobalState(tempDirectory, {
      roots: [TEST_WORKSPACE_ROOT, importedProjectRoot],
      activeRoots: [importedProjectRoot],
      labels: {
        [importedProjectRoot]: "Imported Project",
      },
    });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
      codexDesktopGlobalStatePath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-apply",
        method: "desktop-workspace-import/apply",
        params: {
          roots: [importedProjectRoot],
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-apply",
      type: "response",
      resultType: "success",
      result: {
        importedRoots: [importedProjectRoot],
        skippedRoots: [],
        promptSeen: true,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "workspace-root-options-updated",
    });
    expect(emittedMessages).toContainEqual({
      type: "active-workspace-roots-updated",
    });

    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      '"desktopImportPromptSeen": true',
    );

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-list",
        method: "desktop-workspace-import/list",
      }),
    ).resolves.toEqual({
      requestId: "ipc-list",
      type: "response",
      resultType: "success",
      result: {
        found: true,
        path: codexDesktopGlobalStatePath,
        promptSeen: true,
        shouldPrompt: false,
        projects: [
          {
            root: TEST_WORKSPACE_ROOT,
            label: "pocodex",
            activeInCodex: false,
            alreadyImported: false,
            available: true,
          },
          {
            root: importedProjectRoot,
            label: "Imported Project",
            activeInCodex: true,
            alreadyImported: true,
            available: true,
          },
        ],
      },
    });

    await bridge.close();
  });

  it("returns empty-state host metadata and reports existing paths", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-os",
      method: "POST",
      url: "vscode://codex/os-info",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-home",
      method: "POST",
      url: "vscode://codex/codex-home",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-copilot",
      method: "POST",
      url: "vscode://codex/get-copilot-api-proxy-info",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-config",
      method: "POST",
      url: "vscode://codex/mcp-codex-config",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-instructions",
      method: "POST",
      url: "vscode://codex/developer-instructions",
      body: JSON.stringify({
        params: {
          baseInstructions: "Use concise output.",
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-paths",
      method: "POST",
      url: "vscode://codex/paths-exist",
      body: JSON.stringify({
        paths: [TEST_WORKSPACE_ROOT, TEST_MISSING_ROOT],
      }),
    });

    await waitForCondition(() => emittedMessages.length >= 4);

    expect(getFetchJsonBody(emittedMessages, "fetch-os")).toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
      hasWsl: false,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-home")).toEqual({
      codexHome: expect.stringContaining("/.codex"),
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-copilot")).toEqual({});

    expect(getFetchJsonBody(emittedMessages, "fetch-config")).toEqual({
      ok: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-instructions")).toEqual({
      instructions: "Use concise output.",
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-paths")).toEqual({
      existingPaths: [TEST_WORKSPACE_ROOT],
    });

    await bridge.close();
  });

  it("reads and writes personal agents.md content from codex home", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    const agentsPath = join(codexHome, "agents.md");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-agents-read-empty",
      method: "POST",
      url: "vscode://codex/codex-agents-md",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-agents-save",
      method: "POST",
      url: "vscode://codex/codex-agents-md-save",
      body: JSON.stringify({
        params: {
          contents: "Use concise output.\n",
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-agents-read-saved",
      method: "POST",
      url: "vscode://codex/codex-agents-md",
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-agents-read-saved")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-agents-read-empty")).toEqual({
      path: agentsPath,
      contents: "",
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-agents-save")).toEqual({
      path: agentsPath,
    });

    expect(await readFile(agentsPath, "utf8")).toBe("Use concise output.\n");

    expect(getFetchJsonBody(emittedMessages, "fetch-agents-read-saved")).toEqual({
      path: agentsPath,
      contents: "Use concise output.\n",
    });

    await bridge.close();
  });

  it("resolves git origins for repo-backed directories", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-origins-"));
    tempDirs.push(tempDirectory);
    const { repoRoot, nestedDirectory, outsideDirectory } =
      await createGitOriginFixture(tempDirectory);

    const bridge = await createBridge(children);
    try {
      const emittedMessages: unknown[] = [];
      bridge.on("bridge_message", (message) => {
        emittedMessages.push(message);
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-git-origins",
        method: "POST",
        url: "vscode://codex/git-origins",
        body: JSON.stringify({
          params: {
            dirs: [repoRoot, nestedDirectory, outsideDirectory],
          },
        }),
      });

      await waitForCondition(() =>
        emittedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "requestId" in message &&
            message.type === "fetch-response" &&
            message.requestId === "fetch-git-origins",
        ),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-git-origins")).toEqual({
        origins: [
          {
            dir: repoRoot,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
          {
            dir: nestedDirectory,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
        ],
        homeDir: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("resolves git origins from workspace roots when dirs are omitted", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-origins-"));
    tempDirs.push(tempDirectory);
    const { repoRoot } = await createGitOriginFixture(tempDirectory);
    const workspaceRootRegistryPath = await writeWorkspaceRootRegistry(tempDirectory, {
      roots: [repoRoot],
      activeRoot: repoRoot,
    });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    try {
      const emittedMessages: unknown[] = [];
      bridge.on("bridge_message", (message) => {
        emittedMessages.push(message);
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-git-origins-defaults",
        method: "POST",
        url: "vscode://codex/git-origins",
      });

      await waitForCondition(() =>
        emittedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "requestId" in message &&
            message.type === "fetch-response" &&
            message.requestId === "fetch-git-origins-defaults",
        ),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-git-origins-defaults")).toEqual({
        origins: [
          {
            dir: repoRoot,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
        ],
        homeDir: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("includes sibling worktrees when resolving git origins", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-origins-"));
    tempDirs.push(tempDirectory);
    const { repoRoot, worktreeRoot } = await createGitOriginFixture(tempDirectory, {
      addWorktree: true,
    });
    if (!worktreeRoot) {
      throw new Error("Expected linked worktree fixture to be created");
    }

    const bridge = await createBridge(children);
    try {
      const emittedMessages: unknown[] = [];
      bridge.on("bridge_message", (message) => {
        emittedMessages.push(message);
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-git-origins-worktrees",
        method: "POST",
        url: "vscode://codex/git-origins",
        body: JSON.stringify({
          params: {
            dirs: [repoRoot],
          },
        }),
      });

      await waitForCondition(() =>
        emittedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "requestId" in message &&
            message.type === "fetch-response" &&
            message.requestId === "fetch-git-origins-worktrees",
        ),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-git-origins-worktrees")).toEqual({
        origins: [
          {
            dir: repoRoot,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
          {
            dir: worktreeRoot,
            root: worktreeRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
        ],
        homeDir: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("stubs wham endpoints locally instead of proxying to chatgpt.com", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-wham-environments",
      method: "GET",
      url: "/wham/environments",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-wham-tasks",
      method: "GET",
      url: "/wham/tasks/list?limit=20&task_filter=current",
    });

    await waitForCondition(() => emittedMessages.length >= 2);

    expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([]);

    expect(getFetchJsonBody(emittedMessages, "fetch-wham-tasks")).toEqual({
      items: [],
      tasks: [],
      nextCursor: null,
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-wham-accounts",
      method: "GET",
      url: "/wham/accounts/check",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-wham-usage",
      method: "GET",
      url: "/wham/usage",
    });

    await waitForCondition(() => emittedMessages.length >= 4);

    expect(getFetchJsonBody(emittedMessages, "fetch-wham-accounts")).toEqual({
      accounts: [],
      account_ordering: [],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage")).toEqual({
      credits: null,
      plan_type: null,
      rate_limit: null,
    });

    await bridge.close();
  });

  it("delegates git worker messages through the desktop worker bridge", async () => {
    const gitWorkerBridge = new FakeGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge,
    });
    const workerMessages: Array<{ workerName: string; message: unknown }> = [];
    bridge.on("worker_message", (workerName, message) => {
      workerMessages.push({ workerName, message });
    });

    await bridge.sendWorkerMessage("git", {
      type: "worker-request",
      workerId: "git",
      request: {
        id: "worker-1",
        method: "stable-metadata",
        params: {
          cwd: TEST_WORKSPACE_ROOT,
        },
      },
    });

    expect(gitWorkerBridge.sentMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: "worker-1",
          method: "stable-metadata",
          params: {
            cwd: TEST_WORKSPACE_ROOT,
          },
        },
      },
    ]);

    gitWorkerBridge.emit("message", {
      type: "worker-response",
      workerId: "git",
      response: {
        id: "worker-1",
        method: "stable-metadata",
        result: {
          type: "ok",
          value: {
            commonDir: "/repo/.git",
            root: "/repo",
          },
        },
      },
    });

    expect(workerMessages).toEqual([
      {
        workerName: "git",
        message: {
          type: "worker-response",
          workerId: "git",
          response: {
            id: "worker-1",
            method: "stable-metadata",
            result: {
              type: "ok",
              value: {
                commonDir: "/repo/.git",
                root: "/repo",
              },
            },
          },
        },
      },
    ]);

    expect(gitWorkerBridge.closeCalls).toBe(0);
    await bridge.close();
    expect(gitWorkerBridge.closeCalls).toBe(1);
  });

  it("delegates git worker subscriptions to the desktop worker bridge", async () => {
    const gitWorkerBridge = new FakeGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge,
    });

    await bridge.subscribeWorker("git");
    await bridge.unsubscribeWorker("git");
    await bridge.subscribeWorker("not-supported");

    expect(gitWorkerBridge.subscriptions).toEqual(["subscribe", "unsubscribe"]);

    await bridge.close();
  });

  it("sanitizes desktop-specific thread resume params before forwarding", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "resume-1",
        method: "thread/resume",
        params: {
          threadId: "thr_123",
          cwd: TEST_WORKSPACE_ROOT,
          config: {
            analytics: "",
          },
          path: "/tmp/thread.jsonl",
          history: null,
          modelProvider: "codex_vscode_copilot",
          sandbox: "workspace-write",
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/resume"');
    expect(forwarded).toContain('"threadId":"thr_123"');
    expect(forwarded).toContain(`"cwd":"${TEST_WORKSPACE_ROOT}"`);
    expect(forwarded).not.toContain('"config"');
    expect(forwarded).not.toContain('"modelProvider"');
    expect(forwarded).not.toContain('"path"');

    await bridge.close();
  });

  it("drops desktop config from thread start params before forwarding", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "start-1",
        method: "thread/start",
        params: {
          cwd: TEST_WORKSPACE_ROOT,
          model: "gpt-5.4",
          modelProvider: "codex_vscode_copilot",
          config: {
            analytics: "",
            model: "gpt-5.4",
          },
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/start"');
    expect(forwarded).toContain(`"cwd":"${TEST_WORKSPACE_ROOT}"`);
    expect(forwarded).toContain('"model":"gpt-5.4"');
    expect(forwarded).not.toContain('"config"');
    expect(forwarded).not.toContain('"modelProvider"');

    await bridge.close();
  });

  it("preserves the model from config when sanitizing thread start params", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "start-2",
        method: "thread/start",
        params: {
          cwd: TEST_WORKSPACE_ROOT,
          config: {
            analytics: "",
            model: "gpt-5.4",
          },
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/start"');
    expect(forwarded).toContain(`"cwd":"${TEST_WORKSPACE_ROOT}"`);
    expect(forwarded).toContain('"model":"gpt-5.4"');
    expect(forwarded).not.toContain('"config"');

    await bridge.close();
  });
});

async function createBridge(
  children: MockChildProcess[],
  options: {
    codexDesktopGlobalStatePath?: string;
    persistedAtomRegistryPath?: string;
    workspaceRootRegistryPath?: string;
    gitWorkerBridge?: FakeGitWorkerBridge;
  } = {},
) {
  const { spawn } = await import("node:child_process");
  const { spawn: spawnPty } = await import("node-pty");
  vi.mocked(spawn).mockImplementation(() => {
    const child = new MockChildProcess();
    children.push(child);
    return child as never;
  });
  vi.mocked(spawnPty).mockImplementation((file, args, ptyOptions) => {
    const pty = new MockPty(file, args, ptyOptions as Record<string, unknown>);
    mockPtys.push(pty);
    return pty as never;
  });

  const { AppServerBridge } = await import("../src/lib/app-server-bridge.js");
  let workspaceRootRegistryPath = options.workspaceRootRegistryPath;
  if (!workspaceRootRegistryPath) {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);
    workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
  }
  return AppServerBridge.connect({
    appPath: "/Applications/Codex.app",
    codexCliPath: "/tmp/mock-codex",
    cwd: TEST_WORKSPACE_ROOT,
    codexDesktopGlobalStatePath: options.codexDesktopGlobalStatePath,
    persistedAtomRegistryPath: options.persistedAtomRegistryPath,
    workspaceRootRegistryPath,
    gitWorkerBridge: options.gitWorkerBridge,
  });
}

async function writeDesktopGlobalState(
  tempDirectory: string,
  state: {
    roots: string[];
    activeRoots?: string[];
    labels?: Record<string, string>;
  },
): Promise<string> {
  const statePath = join(tempDirectory, ".codex-global-state.json");

  for (const root of state.roots) {
    await mkdir(root, { recursive: true });
  }

  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        "electron-saved-workspace-roots": state.roots,
        "active-workspace-roots": state.activeRoots ?? [],
        "electron-workspace-root-labels": state.labels ?? {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return statePath;
}

function getFetchResponse(messages: unknown[], requestId: string) {
  return messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      "requestId" in message &&
      (message as { type?: unknown }).type === "fetch-response" &&
      (message as { requestId?: unknown }).requestId === requestId,
  );
}

function isBridgeMessage<TType extends string>(
  message: unknown,
  type: TType,
): message is { type: TType; sessionId?: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type?: unknown }).type === type
  );
}

function getFetchJsonBody(messages: unknown[], requestId: string): unknown {
  const message = getFetchResponse(messages, requestId) as
    | {
        bodyJsonString?: string;
      }
    | undefined;
  if (!message?.bodyJsonString) {
    return null;
  }
  return JSON.parse(message.bodyJsonString);
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createGitOriginFixture(
  tempDirectory: string,
  options: {
    addWorktree?: boolean;
  } = {},
): Promise<{
  repoRoot: string;
  nestedDirectory: string;
  outsideDirectory: string;
  worktreeRoot: string | null;
}> {
  const repoDirectory = join(tempDirectory, "repo");
  const outsideDirectory = join(tempDirectory, "outside");

  await mkdir(join(repoDirectory, "nested"), { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  await runExecFile("git", ["init", "-q"], repoDirectory);
  await runExecFile("git", ["config", "user.name", "Pocodex Test"], repoDirectory);
  await runExecFile("git", ["config", "user.email", "pocodex@example.com"], repoDirectory);
  await runExecFile("git", ["remote", "add", "origin", TEST_PUBLIC_ORIGIN_URL], repoDirectory);
  await writeFile(join(repoDirectory, "README.md"), "fixture\n", "utf8");
  await runExecFile("git", ["add", "README.md"], repoDirectory);
  await runExecFile("git", ["commit", "-q", "-m", "fixture"], repoDirectory);

  const repoRoot = await runExecFile("git", ["rev-parse", "--show-toplevel"], repoDirectory);
  let worktreeRoot: string | null = null;
  if (options.addWorktree) {
    const worktreeDirectory = join(tempDirectory, "repo-worktree");
    await runExecFile(
      "git",
      ["worktree", "add", "-q", "-b", "feature", worktreeDirectory],
      repoRoot,
    );
    worktreeRoot = await runExecFile("git", ["rev-parse", "--show-toplevel"], worktreeDirectory);
  }

  return {
    repoRoot,
    nestedDirectory: join(repoRoot, "nested"),
    outsideDirectory,
    worktreeRoot,
  };
}

async function writeWorkspaceRootRegistry(
  tempDirectory: string,
  state: {
    roots: string[];
    activeRoot?: string | null;
    labels?: Record<string, string>;
    desktopImportPromptSeen?: boolean;
  },
): Promise<string> {
  const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
  await writeFile(
    workspaceRootRegistryPath,
    `${JSON.stringify(
      {
        version: 1,
        roots: state.roots,
        labels: state.labels ?? {},
        activeRoot: state.activeRoot ?? state.roots[0] ?? null,
        desktopImportPromptSeen: state.desktopImportPromptSeen === true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return workspaceRootRegistryPath;
}

async function runExecFile(file: string, args: string[], cwd?: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  });
}
