import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const mockLocalRequestResults = new Map<string, unknown>();
const mockLocalRequestErrors = new Map<string, string>();
const mockLocalRequests: Array<{ method: string; params: unknown }> = [];
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
        if (!String(message.id ?? "").startsWith("pocodex-local-")) {
          continue;
        }

        const localRequest =
          typeof message.method === "string" ? buildMockLocalRequestResponse(message.method) : null;
        if (!localRequest) {
          continue;
        }
        mockLocalRequests.push({
          method: localRequest.method,
          params: "params" in message ? message.params : undefined,
        });

        setImmediate(() => {
          const errorMessage = mockLocalRequestErrors.get(localRequest.method);
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
                    result: localRequest.result,
                  }),
            })}\n`,
          );
        });
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
    mockLocalRequestResults.clear();
    mockLocalRequestErrors.clear();
    mockLocalRequests.length = 0;
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

  it("converts plugin list artwork paths into data URLs", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "pocodex-plugin-root-"));
    tempDirs.push(pluginRoot);
    const assetsPath = join(pluginRoot, "assets");
    await mkdir(assetsPath, { recursive: true });

    const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="#111"/></svg>`;
    const composerSvg = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="#222"/></svg>`;
    const screenshotSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z" fill="#333"/></svg>`;
    const logoPath = join(assetsPath, "logo.svg");
    const composerIconPath = join(assetsPath, "composer.svg");
    const screenshotPath = join(assetsPath, "screenshot.svg");
    await writeFile(logoPath, `${logoSvg}\n`, "utf8");
    await writeFile(composerIconPath, `${composerSvg}\n`, "utf8");
    await writeFile(screenshotPath, `${screenshotSvg}\n`, "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-plugin-list",
        method: "plugin/list",
        params: {},
      },
    });

    const child = children.at(-1);
    child?.stdout.write(
      `${JSON.stringify({
        id: "req-plugin-list",
        result: {
          marketplaces: [
            {
              name: "openai-curated",
              path: join(pluginRoot, "marketplace"),
              plugins: [
                {
                  id: "github",
                  name: "github",
                  authPolicy: "ON_INSTALL",
                  enabled: true,
                  installPolicy: "AVAILABLE",
                  installed: true,
                  source: {
                    type: "local",
                    path: pluginRoot,
                  },
                  interface: {
                    capabilities: ["Interactive"],
                    screenshots: [screenshotPath],
                    displayName: "GitHub",
                    logo: logoPath,
                    composerIcon: composerIconPath,
                  },
                },
              ],
            },
          ],
        },
      })}\n`,
    );

    await waitForCondition(() => Boolean(getMcpResponse(emittedMessages, "req-plugin-list")));

    expect(getMcpJsonResult(emittedMessages, "req-plugin-list")).toEqual({
      marketplaces: [
        {
          name: "openai-curated",
          path: join(pluginRoot, "marketplace"),
          plugins: [
            {
              id: "github",
              name: "github",
              authPolicy: "ON_INSTALL",
              enabled: true,
              installPolicy: "AVAILABLE",
              installed: true,
              source: {
                type: "local",
                path: pluginRoot,
              },
              interface: {
                capabilities: ["Interactive"],
                screenshots: [toSvgDataUrl(`${screenshotSvg}\n`)],
                displayName: "GitHub",
                logo: toSvgDataUrl(`${logoSvg}\n`),
                composerIcon: toSvgDataUrl(`${composerSvg}\n`),
              },
            },
          ],
        },
      ],
    });

    await bridge.close();
  });

  it("converts plugin detail logos and skill icons into data URLs", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "pocodex-plugin-root-"));
    tempDirs.push(pluginRoot);
    const assetsPath = join(pluginRoot, "assets");
    const skillPath = join(pluginRoot, "skills", "demo");
    await mkdir(assetsPath, { recursive: true });
    await mkdir(skillPath, { recursive: true });

    const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="#111"/></svg>`;
    const iconSmallSvg = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" fill="#444"/></svg>`;
    const iconLargeSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2h12v12H2z" fill="#555"/></svg>`;
    const logoPath = join(assetsPath, "logo.svg");
    await writeFile(logoPath, `${logoSvg}\n`, "utf8");
    await writeFile(join(skillPath, "icon-small.svg"), `${iconSmallSvg}\n`, "utf8");
    await writeFile(join(skillPath, "icon-large.svg"), `${iconLargeSvg}\n`, "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-plugin-read",
        method: "plugin/read",
        params: {
          marketplacePath: join(pluginRoot, "marketplace"),
          pluginName: "github",
        },
      },
    });

    const child = children.at(-1);
    child?.stdout.write(
      `${JSON.stringify({
        id: "req-plugin-read",
        result: {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: join(pluginRoot, "marketplace"),
            mcpServers: [],
            apps: [],
            summary: {
              id: "github",
              name: "github",
              authPolicy: "ON_INSTALL",
              enabled: true,
              installPolicy: "AVAILABLE",
              installed: true,
              source: {
                type: "local",
                path: pluginRoot,
              },
              interface: {
                capabilities: ["Interactive"],
                screenshots: [],
                displayName: "GitHub",
                logo: logoPath,
              },
            },
            skills: [
              {
                name: "github",
                description: "Triage GitHub work.",
                path: "skills/demo/SKILL.md",
                interface: {
                  iconSmall: "./icon-small.svg",
                  iconLarge: "./icon-large.svg",
                },
              },
            ],
          },
        },
      })}\n`,
    );

    await waitForCondition(() => Boolean(getMcpResponse(emittedMessages, "req-plugin-read")));

    expect(getMcpJsonResult(emittedMessages, "req-plugin-read")).toEqual({
      plugin: {
        marketplaceName: "openai-curated",
        marketplacePath: join(pluginRoot, "marketplace"),
        mcpServers: [],
        apps: [],
        summary: {
          id: "github",
          name: "github",
          authPolicy: "ON_INSTALL",
          enabled: true,
          installPolicy: "AVAILABLE",
          installed: true,
          source: {
            type: "local",
            path: pluginRoot,
          },
          interface: {
            capabilities: ["Interactive"],
            screenshots: [],
            displayName: "GitHub",
            logo: toSvgDataUrl(`${logoSvg}\n`),
          },
        },
        skills: [
          {
            name: "github",
            description: "Triage GitHub work.",
            path: "skills/demo/SKILL.md",
            interface: {
              iconSmall: toSvgDataUrl(`${iconSmallSvg}\n`),
              iconLarge: toSvgDataUrl(`${iconLargeSvg}\n`),
            },
          },
        ],
      },
    });

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

  it("publishes shared object updates and opens the onboarding workspace picker", async () => {
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
      type: "pocodex-open-workspace-root-picker",
      context: "onboarding",
      initialPath: homedir(),
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

  it("opens the workspace root picker for add-project host actions", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "electron-add-new-workspace-root-option",
    });

    await bridge.forwardBridgeMessage({
      type: "electron-pick-workspace-root-option",
    });

    expect(emittedMessages).toContainEqual({
      type: "pocodex-open-workspace-root-picker",
      context: "manual",
      initialPath: homedir(),
    });
    expect(
      emittedMessages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: unknown }).type === "pocodex-open-workspace-root-picker",
      ),
    ).toHaveLength(2);

    await bridge.close();
  });

  it("opens the workspace root picker when add-workspace-root-option is missing a root", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-add-root-missing",
      method: "POST",
      url: "vscode://codex/add-workspace-root-option",
      body: JSON.stringify({}),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-add-root-missing")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-add-root-missing")).toEqual({
      success: false,
      root: "",
    });
    expect(emittedMessages).toContainEqual({
      type: "pocodex-open-workspace-root-picker",
      context: "manual",
      initialPath: homedir(),
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

  it("lists workspace root picker directories and defaults to the host home directory", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    await mkdir(join(tempDirectory, "beta"), { recursive: true });
    await mkdir(join(tempDirectory, "Alpha"), { recursive: true });
    await writeFile(join(tempDirectory, "README.md"), "fixture\n", "utf8");

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-home",
        method: "workspace-root-picker/list",
      }),
    ).resolves.toEqual({
      requestId: "ipc-home",
      type: "response",
      resultType: "success",
      result: {
        currentPath: homedir(),
        parentPath: dirname(homedir()) === homedir() ? null : dirname(homedir()),
        homePath: homedir(),
        entries: expect.any(Array),
      },
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-list",
        method: "workspace-root-picker/list",
        params: {
          path: tempDirectory,
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-list",
      type: "response",
      resultType: "success",
      result: {
        currentPath: tempDirectory,
        parentPath: dirname(tempDirectory),
        homePath: homedir(),
        entries: [
          {
            name: "Alpha",
            path: join(tempDirectory, "Alpha"),
          },
          {
            name: "beta",
            path: join(tempDirectory, "beta"),
          },
        ],
      },
    });

    await bridge.close();
  });

  it("rejects invalid workspace root picker paths", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const filePath = join(tempDirectory, "file.txt");
    await writeFile(filePath, "fixture\n", "utf8");

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-relative",
        method: "workspace-root-picker/list",
        params: {
          path: "relative/path",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-relative",
      type: "response",
      resultType: "error",
      error: "Folder path must be absolute.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-file",
        method: "workspace-root-picker/list",
        params: {
          path: filePath,
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-file",
      type: "response",
      resultType: "error",
      error: "Choose an existing folder.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-root",
        method: "workspace-root-picker/list",
        params: {
          path: "/",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-root",
      type: "response",
      resultType: "success",
      result: {
        currentPath: "/",
        parentPath: null,
        homePath: homedir(),
        entries: expect.any(Array),
      },
    });

    await bridge.close();
  });

  it("creates workspace root picker directories and rejects invalid names", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "new-project",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create",
      type: "response",
      resultType: "success",
      result: {
        currentPath: join(tempDirectory, "new-project"),
      },
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create-empty",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "  ",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create-empty",
      type: "response",
      resultType: "error",
      error: "Folder name cannot be empty.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create-invalid",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "nested/path",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create-invalid",
      type: "response",
      resultType: "error",
      error: "Folder name cannot contain path separators.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create-existing",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "new-project",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create-existing",
      type: "response",
      resultType: "error",
      error: "That folder already exists.",
    });

    await bridge.close();
  });

  it("confirms new workspace root picker selections, persists them, and emits updates", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const projectRoot = join(tempDirectory, "project-alpha");
    await mkdir(projectRoot, { recursive: true });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-confirm",
        method: "workspace-root-picker/confirm",
        params: {
          path: projectRoot,
          context: "manual",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-confirm",
      type: "response",
      resultType: "success",
      result: {
        action: "added",
        root: projectRoot,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "workspace-root-options-updated",
    });
    expect(emittedMessages).toContainEqual({
      type: "active-workspace-roots-updated",
    });
    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      `"activeRoot": "${projectRoot}"`,
    );

    await bridge.close();
  });

  it("activates existing workspace root picker selections without duplicating roots", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const alphaRoot = join(tempDirectory, "alpha");
    const betaRoot = join(tempDirectory, "beta");
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    const workspaceRootRegistryPath = await writeWorkspaceRootRegistry(tempDirectory, {
      roots: [alphaRoot, betaRoot],
      activeRoot: betaRoot,
    });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-confirm-existing",
        method: "workspace-root-picker/confirm",
        params: {
          path: alphaRoot,
          context: "manual",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-confirm-existing",
      type: "response",
      resultType: "success",
      result: {
        action: "activated",
        root: alphaRoot,
      },
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-active-roots-after-confirm",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-active-roots-after-confirm")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-active-roots-after-confirm")).toEqual({
      roots: [alphaRoot, betaRoot],
    });
    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      `"activeRoot": "${alphaRoot}"`,
    );

    await bridge.close();
  });

  it("emits onboarding success and failure for workspace root picker confirm and cancel", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const projectRoot = join(tempDirectory, "project-onboarding");
    await mkdir(projectRoot, { recursive: true });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-confirm-onboarding",
        method: "workspace-root-picker/confirm",
        params: {
          path: projectRoot,
          context: "onboarding",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-confirm-onboarding",
      type: "response",
      resultType: "success",
      result: {
        action: "added",
        root: projectRoot,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: true,
    });

    emittedMessages.length = 0;

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-cancel-onboarding",
        method: "workspace-root-picker/cancel",
        params: {
          context: "onboarding",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-cancel-onboarding",
      type: "response",
      resultType: "success",
      result: {
        cancelled: true,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: false,
    });

    await bridge.close();
  });

  it("supports workspace-root-option-picked as a compatibility path", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const projectRoot = join(tempDirectory, "project-picked");
    await mkdir(projectRoot, { recursive: true });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "workspace-root-option-picked",
      root: projectRoot,
    });

    expect(emittedMessages).toContainEqual({
      type: "workspace-root-options-updated",
    });
    expect(emittedMessages).toContainEqual({
      type: "active-workspace-roots-updated",
    });
    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      `"activeRoot": "${projectRoot}"`,
    );

    await bridge.close();
  });

  it("returns empty-state host metadata and reports existing paths", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;

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

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-ide-context",
      method: "POST",
      url: "vscode://codex/ide-context",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-recommended-skills",
      method: "POST",
      url: "vscode://codex/recommended-skills",
    });

    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-ide-context")));

    expect(getFetchJsonBody(emittedMessages, "fetch-os")).toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
      hasWsl: false,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-home")).toEqual({
      codexHome,
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

    expect(getFetchJsonBody(emittedMessages, "fetch-recommended-skills")).toEqual({
      repoRoot: join(codexHome, "vendor_imports", "skills"),
      skills: [],
    });

    expect(getFetchResponse(emittedMessages, "fetch-ide-context")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-ide-context",
      responseType: "error",
      status: 503,
      error: "IDE context is unavailable in Pocodex.",
    });

    await bridge.close();
  });

  it("lists curated recommended skills from vendor imports", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;

    const repoRoot = join(codexHome, "vendor_imports", "skills");
    const createPlanSkillPath = join(repoRoot, "skills", ".curated", "create-plan");
    const lintReviewSkillPath = join(repoRoot, "skills", ".curated", "lint-review");
    await mkdir(createPlanSkillPath, { recursive: true });
    await mkdir(lintReviewSkillPath, { recursive: true });
    await writeFile(
      join(createPlanSkillPath, "SKILL.md"),
      `---
name: create-plan
description: Create a concise implementation plan.
metadata:
  short-description: Create a plan
icon-small: ./icon-small.svg
icon-large: ./icon-large.svg
---

# Create Plan
`,
      "utf8",
    );
    await writeFile(
      join(lintReviewSkillPath, "SKILL.md"),
      `---
name: lint-review
description: Review lint issues quickly.
---

# Lint Review
`,
      "utf8",
    );

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-recommended-skills",
      method: "POST",
      url: "vscode://codex/recommended-skills",
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-recommended-skills")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-recommended-skills")).toEqual({
      repoRoot,
      skills: [
        {
          id: "create-plan",
          name: "create-plan",
          description: "Create a concise implementation plan.",
          shortDescription: "Create a plan",
          repoPath: "skills/.curated/create-plan",
          path: "skills/.curated/create-plan",
          iconSmall: "./icon-small.svg",
          iconLarge: "./icon-large.svg",
        },
        {
          id: "lint-review",
          name: "lint-review",
          description: "Review lint issues quickly.",
          shortDescription: null,
          repoPath: "skills/.curated/lint-review",
          path: "skills/.curated/lint-review",
        },
      ],
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

  it("reads skill contents through the webview read-file contract", async () => {
    const skillDirectory = await mkdtemp(join(tmpdir(), "pocodex-skill-"));
    tempDirs.push(skillDirectory);
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(skillPath, "# Demo Skill\n\nUse concise output.\n", "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: skillPath,
        },
      }),
    });

    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-read-file")));

    expect(getFetchJsonBody(emittedMessages, "fetch-read-file")).toEqual({
      path: skillPath,
      contents: "# Demo Skill\n\nUse concise output.\n",
    });

    await bridge.close();
  });

  it("returns a fetch error for invalid read-file paths", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file-invalid",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: "skills/demo/SKILL.md",
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-read-file-invalid")),
    );

    expect(getFetchResponse(emittedMessages, "fetch-read-file-invalid")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-read-file-invalid",
      responseType: "error",
      status: 400,
      error: "File path must be absolute.",
    });

    await bridge.close();
  });

  it("lists local environments for a workspace root using the webview contract", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-gamma");
    await mkdir(join(projectRoot, ".codex", "environments"), { recursive: true });
    const environmentPath = join(projectRoot, ".codex", "environments", "environment.toml");
    await writeFile(
      environmentPath,
      [
        "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
        'name = "Project Gamma"',
        "version = 1",
        "",
        "[setup]",
        'script = "pnpm install"',
        "",
        "[setup.linux]",
        'script = "pnpm install --frozen-lockfile"',
        "",
        "[cleanup]",
        'script = "pnpm cleanup"',
        "",
        "[[actions]]",
        'name = "Run dev"',
        'icon = "run"',
        'command = "pnpm dev"',
        "",
      ].join("\n"),
      "utf8",
    );

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environments-list",
      method: "POST",
      url: "vscode://codex/local-environments",
      body: JSON.stringify({
        params: {
          workspaceRoot: projectRoot,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environments-list")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environments-list")).toEqual({
      environments: [
        {
          configPath: environmentPath,
          exists: true,
          type: "success",
          environment: {
            name: "Project Gamma",
            version: 1,
            setup: {
              script: "pnpm install",
              linux: {
                script: "pnpm install --frozen-lockfile",
              },
            },
            cleanup: {
              script: "pnpm cleanup",
            },
            actions: [
              {
                name: "Run dev",
                icon: "run",
                command: "pnpm dev",
              },
            ],
          },
        },
      ],
    });

    await bridge.close();
  });

  it("reports parse errors for a broken local environment without failing the fetch", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-delta");
    await mkdir(join(projectRoot, ".codex", "environments"), { recursive: true });
    const environmentPath = join(projectRoot, ".codex", "environments", "environment.toml");
    await writeFile(
      environmentPath,
      [
        "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
        'name = "Broken"',
        "[setup",
        'script = "pnpm install"',
      ].join("\n"),
      "utf8",
    );

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-broken-list",
      method: "POST",
      url: "vscode://codex/local-environments",
      body: JSON.stringify({
        params: {
          workspaceRoot: projectRoot,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-broken-config",
      method: "POST",
      url: "vscode://codex/local-environment-config",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-broken-read",
      method: "POST",
      url: "vscode://codex/local-environment",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environment-broken-read")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-broken-list")).toEqual({
      environments: [
        {
          configPath: environmentPath,
          exists: true,
          type: "error",
          error: {
            message: expect.any(String),
          },
        },
      ],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-broken-config")).toEqual({
      configPath: environmentPath,
      exists: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-broken-read")).toEqual({
      environment: {
        type: "error",
        error: {
          message: expect.any(String),
        },
      },
    });

    await bridge.close();
  });

  it("saves raw local environment TOML through the config-save endpoint", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-epsilon");
    await mkdir(projectRoot, { recursive: true });
    const environmentPath = join(projectRoot, ".codex", "environments", "environment.toml");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-config-missing",
      method: "POST",
      url: "vscode://codex/local-environment-config",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    const rawEnvironment = [
      'name = "Project Epsilon"',
      "version = 1",
      "",
      "[setup]",
      'script = "pnpm install"',
      "",
      "[setup.darwin]",
      'script = "pnpm install:mac"',
      "",
      "[cleanup]",
      'script = "pnpm cleanup"',
      "",
      "[cleanup.linux]",
      'script = "pnpm cleanup:linux"',
      "",
      "[[actions]]",
      'name = "Run dev"',
      'icon = "run"',
      'command = "pnpm dev"',
      "",
      "[[actions]]",
      'name = "Test"',
      'icon = "test"',
      'command = "pnpm test"',
      'platform = "linux"',
      "",
    ].join("\n");

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-config-save",
      method: "POST",
      url: "vscode://codex/local-environment-config-save",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
          raw: rawEnvironment,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-read-saved",
      method: "POST",
      url: "vscode://codex/local-environment",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environment-read-saved")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-config-missing")).toEqual({
      configPath: environmentPath,
      exists: false,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-config-save")).toEqual({
      configPath: environmentPath,
      exists: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-read-saved")).toEqual({
      environment: {
        type: "success",
        environment: {
          name: "Project Epsilon",
          version: 1,
          setup: {
            script: "pnpm install",
            darwin: {
              script: "pnpm install:mac",
            },
          },
          cleanup: {
            script: "pnpm cleanup",
            linux: {
              script: "pnpm cleanup:linux",
            },
          },
          actions: [
            {
              name: "Run dev",
              icon: "run",
              command: "pnpm dev",
            },
            {
              name: "Test",
              icon: "test",
              command: "pnpm test",
              platform: "linux",
            },
          ],
        },
      },
    });

    const savedFile = await readFile(environmentPath, "utf8");
    expect(savedFile).toContain("# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY");
    expect(savedFile).toContain('name = "Project Epsilon"');
    expect(savedFile).toContain("[cleanup.linux]");
    expect(savedFile).toContain('platform = "linux"');

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

  it("proxies wham endpoints through backend-api with managed auth", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    await writeCodexAuthFile(codexHome, {
      accessToken: "test-access-token",
      accountId: "acct_personal",
    });

    const proxiedRequests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: normalizeFetchRequestHeaders(init?.headers),
        body: normalizeFetchRequestBody(init?.body),
      };
      proxiedRequests.push(request);

      if (request.url === "https://chatgpt.com/backend-api/wham/environments") {
        return createJsonResponse([{ id: "env_1", name: "Default" }]);
      }
      if (
        request.url ===
        "https://chatgpt.com/backend-api/wham/tasks/list?limit=20&task_filter=current"
      ) {
        return createJsonResponse({
          items: [{ id: "task_1", status: "running" }],
          cursor: "cursor_1",
        });
      }
      if (request.url === "https://chatgpt.com/backend-api/wham/accounts/check") {
        return createJsonResponse({
          accounts: [{ id: "acct_personal", status: "active" }],
          account_ordering: ["acct_personal"],
          default_account_id: "acct_personal",
        });
      }
      if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
        return createJsonResponse({
          plan_type: "plus",
          credits: null,
        });
      }
      if (request.url === "https://chatgpt.com/backend-api/wham/tasks") {
        return createJsonResponse(
          {
            id: "task_new",
            status: "queued",
          },
          201,
        );
      }

      throw new Error(`Unexpected proxied fetch: ${request.url}`);
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
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

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-create-task",
        method: "POST",
        url: "/wham/tasks",
        headers: {
          "x-test-header": "keep-me",
        },
        body: JSON.stringify({
          prompt: "ship it",
        }),
      });

      await waitForCondition(() =>
        Boolean(getFetchResponse(emittedMessages, "fetch-wham-create-task")),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([
        {
          id: "env_1",
          name: "Default",
        },
      ]);
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-tasks")).toEqual({
        items: [{ id: "task_1", status: "running" }],
        cursor: "cursor_1",
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-accounts")).toEqual({
        accounts: [{ id: "acct_personal", status: "active" }],
        account_ordering: ["acct_personal"],
        default_account_id: "acct_personal",
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage")).toEqual({
        plan_type: "plus",
        credits: null,
      });
      expect(getFetchResponse(emittedMessages, "fetch-wham-create-task")).toMatchObject({
        status: 201,
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-create-task")).toEqual({
        id: "task_new",
        status: "queued",
      });

      expect(proxiedRequests.map((request) => request.url)).toEqual([
        "https://chatgpt.com/backend-api/wham/environments",
        "https://chatgpt.com/backend-api/wham/tasks/list?limit=20&task_filter=current",
        "https://chatgpt.com/backend-api/wham/accounts/check",
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/wham/tasks",
      ]);

      for (const request of proxiedRequests) {
        expect(request.headers.authorization).toBe("Bearer test-access-token");
        expect(request.headers["chatgpt-account-id"]).toBe("acct_personal");
        expect(request.headers.originator).toBe("codex_cli_rs");
      }

      expect(proxiedRequests.at(-1)).toMatchObject({
        method: "POST",
        body: JSON.stringify({
          prompt: "ship it",
        }),
      });
      expect(proxiedRequests.at(-1)?.headers["content-type"]).toBe("application/json");
      expect(proxiedRequests.at(-1)?.headers["x-test-header"]).toBe("keep-me");
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it.each([
    {
      name: "managed auth file is missing",
      auth: null,
    },
    {
      name: "managed auth is missing an access token",
      auth: {
        accountId: "acct_personal",
      },
    },
    {
      name: "managed auth is missing an account id",
      auth: {
        accessToken: "test-access-token",
      },
    },
  ])("falls back to local placeholder wham responses when $name", async ({ auth }) => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;

    if (auth) {
      await writeCodexAuthFile(codexHome, auth);
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected remote fetch");
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
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

      await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-wham-usage")));

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([]);
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-tasks")).toEqual({
        items: [],
        tasks: [],
        nextCursor: null,
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-accounts")).toEqual({
        accounts: [],
        account_ordering: [],
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage")).toEqual({
        credits: null,
        plan_type: null,
        rate_limit_name: null,
        rate_limit: null,
        additional_rate_limits: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("refreshes managed auth and retries wham requests once after a 401", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    await writeCodexAuthFile(codexHome, {
      accessToken: "stale-access-token",
      accountId: "acct_stale",
    });

    const proxiedRequests: Array<{ headers: Record<string, string> }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = normalizeFetchRequestHeaders(init?.headers);
      proxiedRequests.push({ headers });

      if (headers.authorization === "Bearer stale-access-token") {
        await writeCodexAuthFile(codexHome, {
          accessToken: "fresh-access-token",
          accountId: "acct_fresh",
        });
        return createJsonResponse(
          {
            error: "expired",
          },
          401,
        );
      }

      if (headers.authorization === "Bearer fresh-access-token") {
        return createJsonResponse([{ id: "env_1" }]);
      }

      throw new Error("Unexpected auth header");
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-environments",
        method: "GET",
        url: "/wham/environments",
      });

      await waitForCondition(() =>
        Boolean(getFetchResponse(emittedMessages, "fetch-wham-environments")),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([
        {
          id: "env_1",
        },
      ]);
      expect(proxiedRequests).toHaveLength(2);
      expect(proxiedRequests[0]?.headers.authorization).toBe("Bearer stale-access-token");
      expect(proxiedRequests[1]?.headers.authorization).toBe("Bearer fresh-access-token");
      expect(mockLocalRequests).toContainEqual({
        method: "account/read",
        params: {
          refreshToken: true,
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("returns a safe local usage fallback when account rate limits cannot be read", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected remote fetch");
    });
    mockLocalRequestErrors.set("account/rateLimits/read", "rate limits unavailable");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-usage-fallback",
        method: "GET",
        url: "/wham/usage",
      });

      await waitForCondition(() => emittedMessages.length >= 1);

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage-fallback")).toEqual({
        credits: null,
        plan_type: null,
        rate_limit_name: null,
        rate_limit: null,
        additional_rate_limits: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("reads account info from the local app server and filters unsupported plans", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    mockLocalRequestResults.set("account/read", {
      account: {
        planType: "plus",
      },
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-account-plus",
      method: "POST",
      url: "vscode://codex/account-info",
    });

    mockLocalRequestResults.set("account/read", {
      account: {
        planType: "enterprise",
      },
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-account-unsupported",
      method: "POST",
      url: "vscode://codex/account-info",
    });

    mockLocalRequestErrors.set("account/read", "account unavailable");

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-account-error",
      method: "POST",
      url: "vscode://codex/account-info",
    });

    await waitForCondition(() => emittedMessages.length >= 3);

    expect(getFetchJsonBody(emittedMessages, "fetch-account-plus")).toEqual({
      plan: "plus",
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-account-unsupported")).toEqual({
      plan: null,
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-account-error")).toEqual({
      plan: null,
    });

    await bridge.close();
  });

  it("serves read-only billing endpoints locally and blocks unsupported billing actions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected remote fetch");
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-settings",
        method: "GET",
        url: "/subscriptions/auto_top_up/settings",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-accounts-check-versioned",
        method: "GET",
        url: "/accounts/check/v4-2023-04-27",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-pricing-config",
        method: "GET",
        url: "/checkout_pricing_config/configs/USD",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-enable",
        method: "POST",
        url: "/subscriptions/auto_top_up/enable",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-update",
        method: "POST",
        url: "/subscriptions/auto_top_up/update",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-disable",
        method: "POST",
        url: "/subscriptions/auto_top_up/disable",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-customer-portal",
        method: "GET",
        url: "/payments/customer_portal",
      });

      await waitForCondition(() => emittedMessages.length >= 7);

      expect(getFetchJsonBody(emittedMessages, "fetch-auto-top-up-settings")).toEqual({
        is_enabled: false,
        recharge_threshold: null,
        recharge_target: null,
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-accounts-check-versioned")).toEqual({
        accounts: {},
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-pricing-config")).toEqual({
        currency_config: null,
      });

      for (const requestId of [
        "fetch-auto-top-up-enable",
        "fetch-auto-top-up-update",
        "fetch-auto-top-up-disable",
        "fetch-customer-portal",
      ]) {
        expect(getFetchResponse(emittedMessages, requestId)).toMatchObject({
          type: "fetch-response",
          requestId,
          responseType: "success",
          status: 501,
        });
        expect(getFetchJsonBody(emittedMessages, requestId)).toEqual({
          error: "unsupported in Pocodex",
        });
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
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
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-thread-resume-"));
    tempDirs.push(tempDirectory);
    const missingThreadPath = join(tempDirectory, "missing-thread.jsonl");

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
          path: missingThreadPath,
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

  it("preserves an existing local thread resume path", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-thread-resume-"));
    tempDirs.push(tempDirectory);
    const threadPath = join(tempDirectory, "thread.jsonl");
    await writeFile(threadPath, '{"type":"thread"}\n', "utf8");

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "resume-2",
        method: "thread/resume",
        params: {
          threadId: "thr_123",
          path: threadPath,
          cwd: TEST_WORKSPACE_ROOT,
          modelProvider: "codex_vscode_copilot",
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/resume"');
    expect(forwarded).toContain('"threadId":"thr_123"');
    expect(forwarded).toContain(`"path":"${threadPath}"`);
    expect(forwarded).not.toContain('"modelProvider"');

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
    persistedAtomRegistryPath: options.persistedAtomRegistryPath,
    workspaceRootRegistryPath,
    gitWorkerBridge: options.gitWorkerBridge,
  });
}

function buildMockLocalRequestResponse(method: string): {
  method: string;
  result: unknown;
} | null {
  switch (method) {
    case "initialize":
    case "config/read":
      return {
        method,
        result: {
          ok: true,
        },
      };
    case "thread/list":
      return {
        method,
        result: {
          data: mockLocalThreadListData,
          nextCursor: null,
        },
      };
    case "thread/archive":
    case "thread/unarchive":
      return {
        method,
        result: {
          ok: true,
        },
      };
    case "account/read":
      return {
        method,
        result: mockLocalRequestResults.get(method) ?? {
          account: {
            planType: null,
          },
        },
      };
    case "account/rateLimits/read":
      return {
        method,
        result: mockLocalRequestResults.get(method) ?? {
          rateLimits: null,
          rateLimitsByLimitId: {},
        },
      };
    default:
      return null;
  }
}

async function writeCodexAuthFile(
  codexHome: string,
  auth: {
    accessToken?: string;
    accountId?: string;
  },
): Promise<string> {
  const authPath = join(codexHome, "auth.json");
  await writeFile(
    authPath,
    `${JSON.stringify(
      {
        tokens: {
          access_token: auth.accessToken,
          account_id: auth.accountId,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return authPath;
}

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function normalizeFetchRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const requestHeaders = new Headers(headers);
  requestHeaders.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function normalizeFetchRequestBody(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body === null || body === undefined) {
    return null;
  }
  throw new Error(`Unsupported fetch request body in test: ${body.constructor.name}`);
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

function getMcpResponse(messages: unknown[], requestId: string) {
  return messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      "message" in message &&
      (message as { type?: unknown }).type === "mcp-response" &&
      typeof (message as { message?: unknown }).message === "object" &&
      (message as { message: { id?: unknown } }).message.id === requestId,
  );
}

function getMcpJsonResult(messages: unknown[], requestId: string) {
  const response = getMcpResponse(messages, requestId);
  if (
    !response ||
    typeof response !== "object" ||
    response === null ||
    !("message" in response) ||
    typeof response.message !== "object" ||
    response.message === null ||
    !("result" in response.message)
  ) {
    throw new Error(`Missing MCP response for ${requestId}`);
  }

  return response.message.result;
}

function toSvgDataUrl(contents: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(contents).toString("base64")}`;
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
