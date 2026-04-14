import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, vi } from "vitest";

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

export const mockLocalThreadList = { data: [] as unknown[] };
export const mockLocalRequestResults = new Map<string, unknown>();
export const mockLocalRequestErrors = new Map<string, string>();
export const mockLocalRequests: Array<{ method: string; params: unknown }> = [];
export const tempDirs: string[] = [];
export const mockPtys: MockPty[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalShell = process.env.SHELL;
const originalWslDistroName = process.env.WSL_DISTRO_NAME;
const originalWslInterop = process.env.WSL_INTEROP;
export const TEST_WORKSPACE_ROOT = process.cwd();
export const TEST_PROJECT_ALPHA_ROOT = join(TEST_WORKSPACE_ROOT, "..", "project-alpha");
export const TEST_PROJECT_BETA_ROOT = join(TEST_WORKSPACE_ROOT, "..", "project-beta");
export const TEST_NOT_AUTO_ADDED_ROOT = join(TEST_WORKSPACE_ROOT, "..", "not-auto-added");
export const TEST_MISSING_ROOT = join(TEST_WORKSPACE_ROOT, "..", "definitely-missing-path");
export const TEST_PUBLIC_ORIGIN_URL = "https://github.com/davej/pocodex.git";

export class FakeGitWorkerBridge extends EventEmitter {
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

export function describeAppServerBridge(
  register: (context: { children: MockChildProcess[] }) => void,
): void {
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
      mockLocalThreadList.data = [];
      mockLocalRequestResults.clear();
      mockLocalRequestErrors.clear();
      mockLocalRequests.length = 0;
      mockPtys.length = 0;
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      if (originalWslDistroName === undefined) {
        delete process.env.WSL_DISTRO_NAME;
      } else {
        process.env.WSL_DISTRO_NAME = originalWslDistroName;
      }
      if (originalWslInterop === undefined) {
        delete process.env.WSL_INTEROP;
      } else {
        process.env.WSL_INTEROP = originalWslInterop;
      }
      process.env.SHELL = originalShell;
      vi.clearAllMocks();
    });

    register({ children });
  });
}

export async function createBridge(
  children: MockChildProcess[],
  options: {
    codexHomePath?: string;
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

  const { AppServerBridge } = await import("../../src/lib/app-server-bridge.js");
  let workspaceRootRegistryPath = options.workspaceRootRegistryPath;
  if (!workspaceRootRegistryPath) {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);
    workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
  }
  let persistedAtomRegistryPath = options.persistedAtomRegistryPath;
  if (!persistedAtomRegistryPath) {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-persisted-atoms-"));
    tempDirs.push(tempDirectory);
    persistedAtomRegistryPath = join(tempDirectory, "persisted-atoms.json");
  }
  return AppServerBridge.connect({
    appPath: "/Applications/Codex.app",
    codexCliPath: "/tmp/mock-codex",
    cwd: TEST_WORKSPACE_ROOT,
    codexHomePath: options.codexHomePath,
    persistedAtomRegistryPath,
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
          data: mockLocalThreadList.data,
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

export async function writeCodexAuthFile(
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

export function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

export function normalizeFetchRequestHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const requestHeaders = new Headers(headers);
  requestHeaders.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

export function normalizeFetchRequestBody(body: BodyInit | null | undefined): string | null {
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

export function getFetchResponse(messages: unknown[], requestId: string) {
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

export function getMcpResponse(messages: unknown[], requestId: string) {
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

export function getMcpJsonResult(messages: unknown[], requestId: string) {
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

export function toSvgDataUrl(contents: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(contents).toString("base64")}`;
}

export function isBridgeMessage<TType extends string>(
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

export function getFetchJsonBody(messages: unknown[], requestId: string): unknown {
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

export async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function createGitOriginFixture(
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

export async function writeWorkspaceRootRegistry(
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
