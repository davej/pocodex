import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { ensureCodexCliBinary } from "./codex-bundle.js";
import { deriveCodexHomePath } from "./codex-home.js";
import {
  DefaultCodexDesktopGitWorkerBridge,
  type CodexDesktopGitWorkerBridge,
} from "./codex-desktop-git-worker.js";
import { debugLog } from "./debug.js";
import {
  loadLocalEnvironment,
  listLocalEnvironments,
  readLocalEnvironmentConfig,
  saveLocalEnvironmentConfig,
} from "./local-environments.js";
import type { HostBridge, JsonRecord } from "./protocol.js";
import {
  derivePersistedAtomRegistryPath,
  loadPersistedAtomRegistry,
  savePersistedAtomRegistry,
} from "./persisted-atom-registry.js";
import {
  deriveWorkspaceRootRegistryPath,
  loadWorkspaceRootRegistry,
  saveWorkspaceRootRegistry,
  type WorkspaceRootRegistryState,
} from "./workspace-root-registry.js";
import {
  TerminalSessionManager,
  type TerminalAttachMessage,
  type TerminalCloseMessage,
  type TerminalCreateMessage,
  type TerminalResizeMessage,
  type TerminalRunActionMessage,
  type TerminalWriteMessage,
} from "./terminal-session-manager.js";

interface AppServerBridgeOptions {
  appPath: string;
  cwd: string;
  hostId?: string;
  persistedAtomRegistryPath?: string;
  workspaceRootRegistryPath?: string;
  gitWorkerBridge?: CodexDesktopGitWorkerBridge;
  codexCliPath?: string;
}

interface JsonRpcRequest {
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: unknown;
}

interface AppServerFetchRequest {
  type: "fetch";
  requestId: string;
  method?: string;
  url?: string;
  headers?: unknown;
  body?: unknown;
}

interface AppServerFetchCancel {
  type: "cancel-fetch";
  requestId: string;
}

interface RelativeFetchRequestContext {
  rawUrl: string;
  method: string;
  headers?: unknown;
  body?: unknown;
  signal: AbortSignal;
}

interface RelativeFetchResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface ManagedCodexAuth {
  accessToken: string;
  accountId: string;
}

interface AppServerMcpRequestEnvelope {
  type: "mcp-request";
  request?: JsonRpcRequest;
}

interface AppServerMcpResponseEnvelope {
  type: "mcp-response";
  response?: JsonRpcResponse;
  message?: JsonRpcResponse;
}

type WorkspaceRootPickerContext = "manual" | "onboarding";

interface TopLevelRequestMessage {
  type: string;
  requestId: string;
}

interface PersistedAtomUpdateMessage {
  type: "persisted-atom-update";
  key?: unknown;
  value?: unknown;
  deleted?: unknown;
}

interface GitOriginRecord {
  dir: string;
  root: string;
  originUrl: string | null;
}

interface GitRepositoryInfo {
  root: string;
  originUrl: string | null;
}

interface GitOriginsResponse {
  origins: GitOriginRecord[];
  homeDir: string;
}

type UsageVisibilityPlan = "plus" | "pro" | "prolite";

interface LocalRateLimitWindowSnapshot {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface LocalCreditsSnapshot {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
}

interface LocalRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: LocalRateLimitWindowSnapshot | null;
  secondary: LocalRateLimitWindowSnapshot | null;
  credits: LocalCreditsSnapshot | null;
  planType: string | null;
}

interface WhamUsageWindowPayload {
  used_percent: number | null;
  limit_window_seconds: number | null;
  reset_at: number | null;
}

interface WhamUsageRateLimitPayload {
  primary_window: WhamUsageWindowPayload | null;
  secondary_window: WhamUsageWindowPayload | null;
  limit_reached: boolean;
  allowed: boolean;
}

interface WhamAdditionalRateLimitPayload {
  limit_name: string | null;
  rate_limit: WhamUsageRateLimitPayload;
}

interface WhamUsagePayload {
  credits: {
    has_credits: boolean | null;
    unlimited: boolean | null;
    balance: string | null;
  } | null;
  plan_type: string | null;
  rate_limit_name: string | null;
  rate_limit: WhamUsageRateLimitPayload | null;
  additional_rate_limits: WhamAdditionalRateLimitPayload[];
}

const USAGE_CORE_LIMIT_ID = "codex";
const LOCAL_UNSUPPORTED_FETCH_STATUS = 501;
const LOCAL_UNSUPPORTED_FETCH_BODY = {
  error: "unsupported in Pocodex",
};

export class AppServerBridge extends EventEmitter implements HostBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly hostId: string;
  private readonly cwd: string;
  private readonly terminalManager: TerminalSessionManager;
  private readonly localRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private readonly fetchRequests = new Map<string, AbortController>();
  private readonly persistedAtoms = new Map<string, unknown>();
  private readonly globalState = new Map<string, unknown>();
  private readonly pinnedThreadIds = new Set<string>();
  private readonly sharedObjects = new Map<string, unknown>();
  private readonly sharedObjectSubscriptions = new Set<string>();
  private readonly workspaceRoots = new Set<string>();
  private readonly workspaceRootLabels = new Map<string, string>();
  private persistedAtomRegistryPath: string;
  private workspaceRootRegistryPath: string;
  private readonly gitWorkerBridge: CodexDesktopGitWorkerBridge;
  private activeWorkspaceRoot: string | null;
  private desktopImportPromptSeen = false;
  private persistedAtomWritePromise: Promise<void> = Promise.resolve();
  private nextRequestId = 0;
  private isClosing = false;
  private isInitialized = false;
  private connectionState: "connecting" | "connected" | "disconnected" = "connecting";

  override on(event: "bridge_message", listener: (message: unknown) => void): this;
  override on(
    event: "worker_message",
    listener: (workerName: string, message: unknown) => void,
  ): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string | symbol, listener: (...arguments_: any[]) => void): this {
    return super.on(event, listener);
  }

  private constructor(options: AppServerBridgeOptions) {
    super();
    this.hostId = options.hostId ?? "local";
    this.cwd = options.cwd;
    this.persistedAtomRegistryPath =
      options.persistedAtomRegistryPath ?? derivePersistedAtomRegistryPath();
    this.workspaceRootRegistryPath =
      options.workspaceRootRegistryPath ?? deriveWorkspaceRootRegistryPath();
    this.gitWorkerBridge =
      options.gitWorkerBridge ??
      new DefaultCodexDesktopGitWorkerBridge({
        appPath: options.appPath,
        codexAppSessionId: randomUUID(),
      });
    this.activeWorkspaceRoot = null;
    this.sharedObjects.set("host_config", this.buildHostConfig());
    this.sharedObjects.set("remote_connections", []);
    this.sharedObjects.set("diff_comments", []);
    this.sharedObjects.set("diff_comments_from_model", []);
    this.sharedObjects.set("composer_prefill", null);
    this.sharedObjects.set("skills_refresh_nonce", 0);
    this.terminalManager = new TerminalSessionManager({
      cwd: this.cwd,
      emitBridgeMessage: (message) => {
        this.emitBridgeMessage(message);
      },
    });
    this.syncWorkspaceGlobalState();
    const codexCliPath = options.codexCliPath;
    if (!codexCliPath) {
      throw new Error("Resolved Codex CLI path is required before starting the app-server bridge.");
    }
    this.child = spawn(codexCliPath, ["app-server", "--listen", "stdio://"], {
      stdio: "pipe",
    });

    this.bindProcess();
    this.bindGitWorker();
  }

  static async connect(options: AppServerBridgeOptions): Promise<AppServerBridge> {
    const codexCliPath = options.codexCliPath ?? (await ensureCodexCliBinary(options.appPath));
    const bridge = new AppServerBridge({
      ...options,
      codexCliPath,
    });
    await bridge.restorePersistedAtomRegistry();
    await bridge.restoreWorkspaceRootRegistry();
    await bridge.initialize();
    return bridge;
  }

  async close(): Promise<void> {
    this.isClosing = true;
    this.connectionState = "disconnected";
    this.fetchRequests.forEach((controller) => controller.abort());
    this.fetchRequests.clear();
    this.terminalManager.dispose();
    await this.gitWorkerBridge.close().catch((error) => {
      debugLog("git-worker", "failed to close desktop git worker bridge", {
        error: normalizeError(error).message,
      });
    });

    if (!this.child.killed) {
      this.child.kill();
    }

    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
      setTimeout(() => resolve(), 1_000);
    });

    await this.persistedAtomWritePromise.catch(() => undefined);
  }

  async forwardBridgeMessage(message: unknown): Promise<void> {
    if (!isJsonRecord(message) || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "ready":
        this.emitConnectionState();
        return;
      case "log-message":
      case "view-focused":
      case "desktop-notification-show":
      case "desktop-notification-hide":
      case "power-save-blocker-set":
      case "electron-set-badge-count":
      case "hotkey-window-enabled-changed":
      case "window-fullscreen-changed":
      case "trace-recording-state-changed":
      case "trace-recording-uploaded":
      case "copy-conversation-path":
      case "copy-working-directory":
      case "copy-session-id":
      case "copy-deeplink":
      case "toggle-sidebar":
      case "toggle-terminal":
      case "toggle-diff-panel":
      case "toggle-thread-pin":
      case "rename-thread":
      case "find-in-thread":
      case "new-chat":
      case "add-context-file":
      case "navigate-to-route":
      case "navigate-back":
      case "navigate-forward":
      case "thread-stream-state-changed":
      case "thread-archived":
      case "thread-unarchived":
      case "thread-queued-followups-changed":
      case "serverRequest/resolved":
        return;
      case "persisted-atom-sync-request":
        this.emit("bridge_message", {
          type: "persisted-atom-sync",
          state: Object.fromEntries(this.persistedAtoms),
        });
        return;
      case "persisted-atom-update":
        this.handlePersistedAtomUpdate(message as unknown as PersistedAtomUpdateMessage);
        return;
      case "shared-object-subscribe":
        this.handleSharedObjectSubscribe(message);
        return;
      case "shared-object-unsubscribe":
        this.handleSharedObjectUnsubscribe(message);
        return;
      case "shared-object-set":
        this.handleSharedObjectSet(message);
        return;
      case "archive-thread":
        await this.handleThreadArchive(message, "thread/archive");
        return;
      case "unarchive-thread":
        await this.handleThreadArchive(message, "thread/unarchive");
        return;
      case "thread-role-request":
        this.handleThreadRoleRequest(message as unknown as TopLevelRequestMessage);
        return;
      case "electron-onboarding-pick-workspace-or-create-default":
        await this.handleOnboardingPickWorkspaceOrCreateDefault();
        return;
      case "electron-onboarding-skip-workspace":
        await this.handleOnboardingSkipWorkspace();
        return;
      case "electron-pick-workspace-root-option":
      case "electron-add-new-workspace-root-option":
        this.openWorkspaceRootPicker("manual");
        return;
      case "workspace-root-option-picked":
        await this.handleWorkspaceRootOptionPicked(message);
        return;
      case "electron-update-workspace-root-options":
        await this.handleWorkspaceRootsUpdated(message);
        return;
      case "electron-set-active-workspace-root":
        await this.handleSetActiveWorkspaceRoot(message);
        return;
      case "electron-rename-workspace-root-option":
        await this.handleRenameWorkspaceRootOption(message);
        return;
      case "mcp-request":
        await this.handleMcpRequest(message as unknown as AppServerMcpRequestEnvelope);
        return;
      case "mcp-response":
        await this.handleMcpResponse(message as unknown as AppServerMcpResponseEnvelope);
        return;
      case "terminal-create":
        await this.terminalManager.handleCreate(message as TerminalCreateMessage);
        return;
      case "terminal-attach":
        await this.terminalManager.handleAttach(message as TerminalAttachMessage);
        return;
      case "terminal-write":
        this.terminalManager.write(message as TerminalWriteMessage);
        return;
      case "terminal-run-action":
        this.terminalManager.runAction(message as TerminalRunActionMessage);
        return;
      case "terminal-resize":
        this.terminalManager.resize(message as TerminalResizeMessage);
        return;
      case "terminal-close":
        this.terminalManager.close(message as TerminalCloseMessage);
        return;
      case "fetch":
        await this.handleFetchRequest(message as unknown as AppServerFetchRequest);
        return;
      case "cancel-fetch":
        this.handleFetchCancel(message as unknown as AppServerFetchCancel);
        return;
      case "fetch-stream":
        this.emit("bridge_message", {
          type: "fetch-stream-error",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
          error: "Streaming fetch is not supported in Pocodex yet.",
        });
        this.emit("bridge_message", {
          type: "fetch-stream-complete",
          requestId: typeof message.requestId === "string" ? message.requestId : "",
        });
        return;
      case "cancel-fetch-stream":
        return;
      default:
        if (message.type.endsWith("-response") && typeof message.requestId === "string") {
          return;
        }
        debugLog("app-server", "ignoring unsupported browser bridge message", {
          type: message.type,
        });
    }
  }

  async sendWorkerMessage(workerName: string, message: unknown): Promise<void> {
    if (workerName === "git") {
      await this.gitWorkerBridge.send(message);
      return;
    }

    if (!isJsonRecord(message) || message.type !== "worker-request") {
      return;
    }

    const workerId = typeof message.workerId === "string" ? message.workerId : workerName;
    const request = isJsonRecord(message.request) ? message.request : null;
    const requestId =
      request && (typeof request.id === "string" || typeof request.id === "number")
        ? request.id
        : "";
    const method = request && typeof request.method === "string" ? request.method : "unknown";

    this.emit("worker_message", workerName, {
      type: "worker-response",
      workerId,
      response: {
        id: requestId,
        method,
        result: {
          type: "error",
          error: {
            message: `Worker "${workerName}" is not available in Pocodex yet.`,
          },
        },
      },
    });
  }

  async subscribeWorker(workerName: string): Promise<void> {
    if (workerName === "git") {
      await this.gitWorkerBridge.subscribe();
    }
  }

  async unsubscribeWorker(workerName: string): Promise<void> {
    if (workerName === "git") {
      await this.gitWorkerBridge.unsubscribe();
    }
  }

  async handleIpcRequest(payload: unknown): Promise<unknown> {
    if (!isJsonRecord(payload)) {
      return buildIpcErrorResponse("", "Invalid IPC request payload.");
    }

    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const method = typeof payload.method === "string" ? payload.method : "";
    if (!method) {
      return buildIpcErrorResponse(requestId, "Missing IPC method.");
    }

    try {
      switch (method) {
        case "workspace-root-picker/list":
          return buildIpcSuccessResponse(
            requestId,
            await this.listWorkspaceRootPickerEntries(payload.params),
          );
        case "workspace-root-picker/create-directory":
          return buildIpcSuccessResponse(
            requestId,
            await this.createWorkspaceRootPickerDirectory(payload.params),
          );
        case "workspace-root-picker/confirm":
          return buildIpcSuccessResponse(
            requestId,
            await this.confirmWorkspaceRootPickerSelection(payload.params),
          );
        case "workspace-root-picker/cancel":
          return buildIpcSuccessResponse(
            requestId,
            await this.cancelWorkspaceRootPicker(payload.params),
          );
        default:
          return buildIpcErrorResponse(
            requestId,
            `IPC method "${method}" is not supported in Pocodex yet.`,
          );
      }
    } catch (error) {
      return buildIpcErrorResponse(
        requestId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private bindProcess(): void {
    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    const stderr = createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      debugLog("app-server", "stderr", line);
    });

    this.child.on("error", (error) => {
      this.connectionState = "disconnected";
      this.rejectPendingRequests(error);
      this.emit("error", error);
    });

    this.child.once("exit", (code, signal) => {
      this.connectionState = "disconnected";
      this.rejectPendingRequests(
        new Error(
          `Codex app-server exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
        ),
      );
      this.emitConnectionState();

      if (this.isClosing) {
        return;
      }

      const error = new Error("Codex app-server exited unexpectedly.");
      this.emit("bridge_message", {
        type: "codex-app-server-fatal-error",
        hostId: this.hostId,
        message: error.message,
      });
      this.emit("error", error);
    });
  }

  private bindGitWorker(): void {
    this.gitWorkerBridge.on("message", (message) => {
      this.emit("worker_message", "git", message);
    });

    this.gitWorkerBridge.on("error", (error) => {
      debugLog("git-worker", "desktop git worker bridge error", {
        error: error.message,
      });
      this.emit("error", error);
    });
  }

  private async initialize(): Promise<void> {
    debugLog("app-server", "starting initialize handshake", {
      hostId: this.hostId,
    });

    await this.sendLocalRequest("initialize", {
      clientInfo: {
        name: "pocodex",
        title: "Pocodex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.sendJsonRpcMessage({
      method: "initialized",
    });

    this.isInitialized = true;
    this.connectionState = "connected";
  }

  private async restoreWorkspaceRootRegistry(): Promise<void> {
    try {
      const loaded = await loadWorkspaceRootRegistry(this.workspaceRootRegistryPath);
      this.workspaceRootRegistryPath = loaded.path;
      if (loaded.state) {
        this.desktopImportPromptSeen = loaded.state.desktopImportPromptSeen;
        this.applyWorkspaceRootRegistry(loaded.state);
      }
    } catch (error) {
      debugLog("app-server", "failed to restore workspace root registry", {
        error: normalizeError(error).message,
        path: this.workspaceRootRegistryPath,
      });
    }

    this.syncWorkspaceGlobalState();
  }

  private async restorePersistedAtomRegistry(): Promise<void> {
    try {
      const loaded = await loadPersistedAtomRegistry(this.persistedAtomRegistryPath);
      this.persistedAtomRegistryPath = loaded.path;
      this.persistedAtoms.clear();
      for (const [key, value] of Object.entries(loaded.state)) {
        this.persistedAtoms.set(key, value);
      }
    } catch (error) {
      debugLog("app-server", "failed to restore persisted atoms", {
        error: normalizeError(error).message,
        path: this.persistedAtomRegistryPath,
      });
    }
  }

  private async listWorkspaceRootPickerEntries(params: unknown): Promise<{
    currentPath: string;
    parentPath: string | null;
    homePath: string;
    entries: Array<{
      name: string;
      path: string;
    }>;
  }> {
    const currentPath = await this.resolveWorkspaceRootPickerDirectoryPath(params, {
      fallbackToHome: true,
      pathKey: "path",
    });
    const rawEntries = await readdir(currentPath, { withFileTypes: true });
    const entries = await Promise.all(
      rawEntries.map(async (entry) => {
        const path = join(currentPath, entry.name);
        if (!(await this.isDirectory(path))) {
          return null;
        }

        return {
          name: entry.name,
          path,
        };
      }),
    );

    return {
      currentPath,
      parentPath: this.getWorkspaceRootPickerParentPath(currentPath),
      homePath: homedir(),
      entries: entries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "accent",
          }),
        ),
    };
  }

  private async createWorkspaceRootPickerDirectory(params: unknown): Promise<{
    currentPath: string;
  }> {
    if (!isJsonRecord(params)) {
      throw new Error("Missing workspace root picker create-directory params.");
    }

    const parentPath = await this.resolveWorkspaceRootPickerDirectoryPath(params, {
      fallbackToHome: false,
      pathKey: "parentPath",
    });
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) {
      throw new Error("Folder name cannot be empty.");
    }
    if (name === "." || name === "..") {
      throw new Error("Folder name cannot be . or ..");
    }
    if (name.includes("/") || name.includes("\\")) {
      throw new Error("Folder name cannot contain path separators.");
    }

    const currentPath = join(parentPath, name);
    if (existsSync(currentPath)) {
      throw new Error("That folder already exists.");
    }

    await mkdir(currentPath);
    return {
      currentPath,
    };
  }

  private async confirmWorkspaceRootPickerSelection(params: unknown): Promise<{
    action: "activated" | "added";
    root: string;
  }> {
    if (!isJsonRecord(params)) {
      throw new Error("Missing workspace root picker confirm params.");
    }

    const path = typeof params.path === "string" ? params.path : "";
    const context = this.readWorkspaceRootPickerContext(params.context);
    return this.confirmWorkspaceRootSelection(path, context);
  }

  private async cancelWorkspaceRootPicker(params: unknown): Promise<{
    cancelled: true;
  }> {
    const context = isJsonRecord(params)
      ? this.readWorkspaceRootPickerContext(params.context)
      : "manual";
    if (context === "onboarding") {
      this.emitBridgeMessage({
        type: "electron-onboarding-pick-workspace-or-create-default-result",
        success: false,
      });
    }

    return {
      cancelled: true,
    };
  }

  private emitConnectionState(): void {
    this.emit("bridge_message", {
      type: "codex-app-server-connection-changed",
      hostId: this.hostId,
      state: this.connectionState,
      transport: "websocket",
    });

    if (this.isInitialized) {
      this.emit("bridge_message", {
        type: "codex-app-server-initialized",
        hostId: this.hostId,
      });
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    debugLog("app-server", "stdout", line);

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit(
        "error",
        new Error("Failed to parse Codex app-server output.", {
          cause: error instanceof Error ? error : undefined,
        }),
      );
      return;
    }

    if (!isJsonRecord(message)) {
      return;
    }

    if ("id" in message && !("method" in message)) {
      this.handleJsonRpcResponse(message);
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
      this.emit("bridge_message", {
        type: "mcp-request",
        hostId: this.hostId,
        request: {
          id: message.id,
          method: message.method,
          params: message.params,
        },
      });
      return;
    }

    this.emit("bridge_message", {
      type: "mcp-notification",
      hostId: this.hostId,
      method: message.method,
      params: message.params,
    });
  }

  private handleJsonRpcResponse(message: JsonRecord): void {
    const id =
      typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
    if (id && this.localRequests.has(id)) {
      const pending = this.localRequests.get(id);
      this.localRequests.delete(id);
      if (!pending) {
        return;
      }
      if ("error" in message && message.error !== undefined) {
        pending.reject(
          new Error(extractJsonRpcErrorMessage(message.error), {
            cause: message.error instanceof Error ? message.error : undefined,
          }),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    this.emit("bridge_message", {
      type: "mcp-response",
      hostId: this.hostId,
      message: {
        id: message.id,
        ...(message.error !== undefined ? { error: message.error } : { result: message.result }),
      },
    });
  }

  private async handleMcpRequest(message: AppServerMcpRequestEnvelope): Promise<void> {
    if (!message.request || typeof message.request.method !== "string") {
      return;
    }

    const localResult = await this.handleLocalMcpRequest(message.request);
    if (localResult.handled) {
      if (message.request.id !== undefined) {
        this.emitBridgeMessage({
          type: "mcp-response",
          hostId: this.hostId,
          message: {
            id: message.request.id,
            ...(localResult.error !== undefined
              ? { error: localResult.error }
              : { result: localResult.result }),
          },
        });
      }
      return;
    }

    this.sendJsonRpcMessage({
      id: message.request.id,
      method: message.request.method,
      params: this.sanitizeMcpParams(message.request.method, message.request.params),
    });
  }

  private async handleMcpResponse(message: AppServerMcpResponseEnvelope): Promise<void> {
    const response = message.response ?? message.message;
    if (!response || (typeof response.id !== "string" && typeof response.id !== "number")) {
      return;
    }

    this.sendJsonRpcMessage({
      id: response.id,
      ...(response.error !== undefined ? { error: response.error } : { result: response.result }),
    });
  }

  private async handleLocalMcpRequest(request: JsonRpcRequest): Promise<
    | {
        handled: false;
      }
    | {
        handled: true;
        result?: unknown;
        error?: { message: string };
      }
  > {
    switch (request.method) {
      case "thread/archive":
        return this.handleLocalThreadArchiveRequest(request.params, "thread/archive");
      case "thread/unarchive":
        return this.handleLocalThreadArchiveRequest(request.params, "thread/unarchive");
      default:
        return {
          handled: false,
        };
    }
  }

  private async handleLocalThreadArchiveRequest(
    params: unknown,
    _method: "thread/archive" | "thread/unarchive",
  ): Promise<
    | {
        handled: true;
        result: { ok: true };
      }
    | {
        handled: true;
        error: { message: string };
      }
  > {
    const threadId =
      isJsonRecord(params) && typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) {
      return {
        handled: true,
        error: {
          message: "Missing threadId.",
        },
      };
    }

    return {
      handled: true,
      result: {
        ok: true,
      },
    };
  }

  private async handleThreadArchive(
    message: JsonRecord,
    method: "thread/archive" | "thread/unarchive",
  ): Promise<void> {
    const conversationId =
      typeof message.conversationId === "string" ? message.conversationId : null;
    const requestId = typeof message.requestId === "string" ? message.requestId : null;
    if (!conversationId) {
      return;
    }

    try {
      await this.sendLocalRequest(method, {
        threadId: conversationId,
      });
      if (requestId) {
        this.emitBridgeMessage({
          type: "serverRequest/resolved",
          params: {
            threadId: conversationId,
            requestId,
          },
        });
      }
    } catch (error) {
      debugLog("app-server", "failed to update thread archive state", {
        error: normalizeError(error).message,
        method,
        threadId: conversationId,
      });
    }
  }

  private handleThreadRoleRequest(message: TopLevelRequestMessage): void {
    this.emit("bridge_message", {
      type: "thread-role-response",
      requestId: message.requestId,
      role: "owner",
    });
  }

  private async handleFetchRequest(message: AppServerFetchRequest): Promise<void> {
    if (!message.requestId || !message.url) {
      return;
    }

    const controller = new AbortController();
    this.fetchRequests.set(message.requestId, controller);

    try {
      if (message.url === "vscode://codex/ipc-request") {
        const payload = parseJsonBody(message.body);
        const result = await this.handleIpcRequest(payload);
        this.emitFetchSuccess(message.requestId, result);
        return;
      }

      if (message.url.startsWith("vscode://codex/")) {
        const body = parseJsonBody(message.body);
        const handled = await this.handleCodexFetchRequest(
          message.url,
          typeof message.method === "string" ? message.method : "GET",
          body,
        );
        if (handled) {
          if (message.url === "vscode://codex/ide-context") {
            this.emitFetchError(
              message.requestId,
              handled.status,
              "IDE context is unavailable in Pocodex.",
            );
            return;
          }
          this.emitFetchSuccess(message.requestId, handled.body, handled.status);
          return;
        }
        this.emitFetchError(
          message.requestId,
          501,
          `Unsupported Codex host fetch URL: ${message.url}`,
        );
        return;
      }

      if (message.url.startsWith("/")) {
        const handled = await this.handleRelativeFetchRequest({
          rawUrl: message.url,
          method: typeof message.method === "string" ? message.method : "GET",
          headers: message.headers,
          body: message.body,
          signal: controller.signal,
        });
        if (handled) {
          this.emitFetchSuccess(message.requestId, handled.body, handled.status, handled.headers);
          return;
        }

        const response = await fetch(new URL(message.url, "https://chatgpt.com"), {
          method: typeof message.method === "string" ? message.method : "GET",
          headers: buildOutboundFetchHeaders(message.headers, message.body),
          body: normalizeRequestBody(message.body),
          signal: controller.signal,
        });
        const handledResponse = await readRemoteFetchResponse(response);

        this.emit("bridge_message", {
          type: "fetch-response",
          requestId: message.requestId,
          responseType: "success",
          status: handledResponse.status,
          headers: handledResponse.headers,
          bodyJsonString: JSON.stringify(handledResponse.body),
        });
        return;
      }

      const response = await fetch(message.url, {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: buildOutboundFetchHeaders(message.headers, message.body),
        body: normalizeRequestBody(message.body),
        signal: controller.signal,
      });
      const handledResponse = await readRemoteFetchResponse(response);

      this.emit("bridge_message", {
        type: "fetch-response",
        requestId: message.requestId,
        responseType: "success",
        status: handledResponse.status,
        headers: handledResponse.headers,
        bodyJsonString: JSON.stringify(handledResponse.body),
      });
    } catch (error) {
      const normalized = normalizeError(error);
      this.emitFetchError(message.requestId, 500, normalized.message);
    } finally {
      this.fetchRequests.delete(message.requestId);
    }
  }

  private handleFetchCancel(message: AppServerFetchCancel): void {
    this.fetchRequests.get(message.requestId)?.abort();
    this.fetchRequests.delete(message.requestId);
  }

  private handlePersistedAtomUpdate(message: PersistedAtomUpdateMessage): void {
    if (typeof message.key !== "string") {
      return;
    }

    if (message.deleted === true) {
      this.persistedAtoms.delete(message.key);
    } else {
      this.persistedAtoms.set(message.key, message.value);
    }

    this.emit("bridge_message", {
      type: "persisted-atom-updated",
      key: message.key,
      value: message.value,
      deleted: message.deleted === true,
    });

    this.queuePersistedAtomRegistryWrite();
  }

  private queuePersistedAtomRegistryWrite(): void {
    const state = Object.fromEntries(this.persistedAtoms);
    this.persistedAtomWritePromise = this.persistedAtomWritePromise
      .catch(() => undefined)
      .then(async () => {
        try {
          await savePersistedAtomRegistry(this.persistedAtomRegistryPath, state);
        } catch (error) {
          debugLog("app-server", "failed to persist persisted atoms", {
            error: normalizeError(error).message,
            path: this.persistedAtomRegistryPath,
          });
        }
      });
  }

  private handleSharedObjectSubscribe(message: JsonRecord): void {
    const key = this.getSharedObjectKey(message);
    if (!key) {
      return;
    }

    this.sharedObjectSubscriptions.add(key);
    this.emitSharedObjectUpdate(key);
  }

  private handleSharedObjectUnsubscribe(message: JsonRecord): void {
    const key = this.getSharedObjectKey(message);
    if (!key) {
      return;
    }

    this.sharedObjectSubscriptions.delete(key);
  }

  private handleSharedObjectSet(message: JsonRecord): void {
    const key = this.getSharedObjectKey(message);
    if (!key) {
      return;
    }

    this.sharedObjects.set(key, message.value ?? null);
    this.emitSharedObjectUpdate(key);
  }

  private async handleOnboardingPickWorkspaceOrCreateDefault(): Promise<void> {
    this.openWorkspaceRootPicker("onboarding");
  }

  private async handleOnboardingSkipWorkspace(): Promise<void> {
    await this.persistWorkspaceRootRegistry();
    this.emitBridgeMessage({
      type: "electron-onboarding-skip-workspace-result",
      success: true,
    });
  }

  private async handleWorkspaceRootsUpdated(message: JsonRecord): Promise<void> {
    const roots = Array.isArray(message.roots)
      ? message.roots.filter((value): value is string => typeof value === "string")
      : [];
    if (roots.length === 0) {
      this.workspaceRoots.clear();
      this.activeWorkspaceRoot = null;
      await this.persistWorkspaceRootRegistry();
      this.emitWorkspaceRootsUpdated();
      return;
    }

    this.workspaceRoots.clear();
    for (const root of roots) {
      this.workspaceRoots.add(root);
      if (!this.workspaceRootLabels.has(root)) {
        this.workspaceRootLabels.set(root, basename(root) || "Workspace");
      }
    }

    if (!this.activeWorkspaceRoot || !this.workspaceRoots.has(this.activeWorkspaceRoot)) {
      this.activeWorkspaceRoot = roots[0] ?? null;
    }

    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
  }

  private async handleSetActiveWorkspaceRoot(message: JsonRecord): Promise<void> {
    const root = typeof message.root === "string" ? message.root : null;
    if (!root) {
      return;
    }

    this.ensureWorkspaceRoot(root, { setActive: true });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
  }

  private async handleRenameWorkspaceRootOption(message: JsonRecord): Promise<void> {
    const root = typeof message.root === "string" ? message.root : null;
    if (!root) {
      return;
    }

    const label = typeof message.label === "string" ? message.label.trim() : "";
    if (label) {
      this.workspaceRootLabels.set(root, label);
    } else {
      this.workspaceRootLabels.delete(root);
    }

    await this.persistWorkspaceRootRegistry();
    this.emitBridgeMessage({
      type: "workspace-root-options-updated",
    });
  }

  private async handleCodexFetchRequest(
    rawUrl: string,
    method: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown } | null> {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/+/, "");
    switch (path) {
      case "get-global-state":
        return {
          status: 200,
          body: this.readGlobalState(body),
        };
      case "set-global-state":
        return {
          status: 200,
          body: this.writeGlobalState(body),
        };
      case "list-pinned-threads":
        return {
          status: 200,
          body: {
            threadIds: Array.from(this.pinnedThreadIds),
          },
        };
      case "set-thread-pinned":
        return {
          status: 200,
          body: this.setThreadPinned(body),
        };
      case "set-pinned-threads-order":
        return {
          status: 200,
          body: this.setPinnedThreadsOrder(body),
        };
      case "active-workspace-roots":
        return {
          status: 200,
          body: {
            roots: this.getActiveWorkspaceRoots(),
          },
        };
      case "workspace-root-options":
        return {
          status: 200,
          body: {
            roots: Array.from(this.workspaceRoots),
            labels: Object.fromEntries(this.workspaceRootLabels),
          },
        };
      case "add-workspace-root-option":
        return {
          status: 200,
          body: await this.addWorkspaceRootOption(body),
        };
      case "list-pending-automation-run-threads":
        return {
          status: 200,
          body: {
            threadIds: [],
          },
        };
      case "extension-info":
        return {
          status: 200,
          body: {
            version: "0.1.0",
            buildFlavor: "pocodex",
            buildNumber: "0",
          },
        };
      case "is-copilot-api-available":
        return {
          status: 200,
          body: {
            available: false,
          },
        };
      case "get-copilot-api-proxy-info":
        return {
          status: 200,
          body: {},
        };
      case "mcp-codex-config":
        return {
          status: 200,
          body: await this.readCodexConfig(),
        };
      case "developer-instructions":
        return {
          status: 200,
          body: {
            instructions: this.readDeveloperInstructions(body),
          },
        };
      case "os-info":
        return {
          status: 200,
          body: {
            platform: platform(),
            arch: arch(),
            hasWsl: false,
          },
        };
      case "local-environments":
        return {
          status: 200,
          body: await this.handleLocalEnvironmentsRequest(body),
        };
      case "local-environment-config":
        return {
          status: 200,
          body: await this.handleLocalEnvironmentConfigRequest(body),
        };
      case "local-environment":
        return {
          status: 200,
          body: await this.handleLocalEnvironmentRequest(body),
        };
      case "local-environment-config-save":
        return {
          status: 200,
          body: await this.handleLocalEnvironmentConfigSaveRequest(body),
        };
      case "codex-home":
        return {
          status: 200,
          body: {
            codexHome: deriveCodexHomePath(),
          },
        };
      case "codex-agents-md":
        return {
          status: 200,
          body: await this.readCodexAgentsMarkdown(),
        };
      case "codex-agents-md-save":
        return {
          status: 200,
          body: await this.writeCodexAgentsMarkdown(body),
        };
      case "list-automations":
        return {
          status: 200,
          body: {
            items: [],
          },
        };
      case "recommended-skills":
        return {
          status: 200,
          body: {
            skills: [],
          },
        };
      case "fast-mode-rollout-metrics":
        return {
          status: 200,
          body: {
            estimatedSavedMs: 0,
            rolloutCountWithCompletedTurns: 0,
          },
        };
      case "has-custom-cli-executable":
        return {
          status: 200,
          body: {
            hasCustomCliExecutable: false,
          },
        };
      case "locale-info":
        return {
          status: 200,
          body: {
            ideLocale: "en-US",
            systemLocale: Intl.DateTimeFormat().resolvedOptions().locale ?? "en-US",
          },
        };
      case "inbox-items":
        return {
          status: 200,
          body: {
            items: [],
          },
        };
      case "open-in-targets":
        return {
          status: 200,
          body: {
            preferredTarget: null,
            targets: [],
            availableTargets: [],
          },
        };
      case "gh-cli-status":
        return {
          status: 200,
          body: {
            isInstalled: false,
            isAuthenticated: false,
          },
        };
      case "gh-pr-status":
        return {
          status: 200,
          body: {
            status: "unavailable",
            hasOpenPr: false,
            isDraft: false,
            canMerge: false,
            ciStatus: null,
            url: null,
          },
        };
      case "ide-context":
        return {
          status: 503,
          body: {
            error: "IDE context is unavailable in Pocodex.",
          },
        };
      case "paths-exist":
        return {
          status: 200,
          body: {
            existingPaths: this.listExistingPaths(body),
          },
        };
      case "account-info":
        return {
          status: 200,
          body: await this.readAccountInfo(),
        };
      case "get-configuration":
        return {
          status: 200,
          body: {
            value: null,
          },
        };
      case "hotkey-window-hotkey-state":
        return {
          status: 200,
          body: {
            supported: false,
            isDevMode: false,
            isGateEnabled: false,
            isActive: false,
            isDevOverrideEnabled: false,
            configuredHotkey: null,
          },
        };
      case "git-origins":
        return {
          status: 200,
          body: await resolveGitOrigins(body, this.getGitOriginFallbackDirectories()),
        };
      default:
        return null;
    }
  }

  private async handleRelativeFetchRequest(
    request: RelativeFetchRequestContext,
  ): Promise<RelativeFetchResponse | null> {
    const pathname = new URL(request.rawUrl, "https://chatgpt.com").pathname;
    const normalizedMethod = request.method.toUpperCase();

    if (pathname.startsWith("/wham/")) {
      return this.handleWhamFetchRequest(request, pathname, normalizedMethod);
    }

    if (pathname === "/subscriptions/auto_top_up/settings" && normalizedMethod === "GET") {
      return {
        status: 200,
        body: {
          is_enabled: false,
          recharge_threshold: null,
          recharge_target: null,
        },
      };
    }

    if (pathname.startsWith("/accounts/check/") && normalizedMethod === "GET") {
      return {
        status: 200,
        body: {
          accounts: {},
        },
      };
    }

    if (pathname.startsWith("/checkout_pricing_config/configs/") && normalizedMethod === "GET") {
      return {
        status: 200,
        body: {
          currency_config: null,
        },
      };
    }

    if (
      normalizedMethod === "POST" &&
      (pathname === "/subscriptions/auto_top_up/enable" ||
        pathname === "/subscriptions/auto_top_up/update" ||
        pathname === "/subscriptions/auto_top_up/disable")
    ) {
      return {
        status: LOCAL_UNSUPPORTED_FETCH_STATUS,
        body: LOCAL_UNSUPPORTED_FETCH_BODY,
      };
    }

    if (pathname === "/payments/customer_portal" && normalizedMethod === "GET") {
      return {
        status: LOCAL_UNSUPPORTED_FETCH_STATUS,
        body: LOCAL_UNSUPPORTED_FETCH_BODY,
      };
    }

    return null;
  }

  private async handleWhamFetchRequest(
    request: RelativeFetchRequestContext,
    pathname: string,
    normalizedMethod: string,
  ): Promise<RelativeFetchResponse> {
    const auth = await this.readManagedCodexAuth();
    if (!auth) {
      return this.buildWhamFallbackResponse(pathname, normalizedMethod);
    }

    let response = await this.proxyWhamFetchRequest(request, auth);
    if (response.status !== 401 && response.status !== 403) {
      return response;
    }

    await this.sendLocalRequestSafely("account/read", {
      refreshToken: true,
    });
    const refreshedAuth = await this.readManagedCodexAuth();
    if (!refreshedAuth) {
      return response;
    }

    response = await this.proxyWhamFetchRequest(request, refreshedAuth);
    return response;
  }

  private async proxyWhamFetchRequest(
    request: RelativeFetchRequestContext,
    auth: ManagedCodexAuth,
  ): Promise<RelativeFetchResponse> {
    const sourceUrl = new URL(request.rawUrl, "https://chatgpt.com");
    const targetUrl = new URL(`/backend-api${sourceUrl.pathname}${sourceUrl.search}`, sourceUrl);
    const headers = new Headers(buildOutboundFetchHeaders(request.headers, request.body));
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    headers.set("chatgpt-account-id", auth.accountId);
    headers.set("originator", "codex_cli_rs");

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: normalizeRequestBody(request.body),
      signal: request.signal,
    });

    return readRemoteFetchResponse(response);
  }

  private async buildWhamFallbackResponse(
    pathname: string,
    normalizedMethod: string,
  ): Promise<RelativeFetchResponse> {
    if (pathname === "/wham/accounts/check" && normalizedMethod === "GET") {
      return {
        status: 200,
        body: {
          accounts: [],
          account_ordering: [],
        },
      };
    }

    if (pathname === "/wham/environments" && normalizedMethod === "GET") {
      return {
        status: 200,
        body: [],
      };
    }

    if (pathname === "/wham/usage" && normalizedMethod === "GET") {
      return {
        status: 200,
        body: await this.readWhamUsage(),
      };
    }

    if (pathname === "/wham/tasks/list" && normalizedMethod === "GET") {
      return {
        status: 200,
        body: {
          items: [],
          tasks: [],
          nextCursor: null,
        },
      };
    }

    return {
      status: 401,
      body: {
        error: "Managed Codex auth is required for cloud requests.",
      },
    };
  }

  private async readAccountInfo(): Promise<{ plan: UsageVisibilityPlan | null }> {
    const result = await this.sendLocalRequestSafely("account/read", {
      refreshToken: false,
    });
    return {
      plan: readUsageVisibilityPlanFromAccount(result),
    };
  }

  private async readWhamUsage(): Promise<WhamUsagePayload> {
    const result = await this.sendLocalRequestSafely("account/rateLimits/read");
    return buildWhamUsagePayload(result);
  }

  private async readManagedCodexAuth(): Promise<ManagedCodexAuth | null> {
    const authPath = join(deriveCodexHomePath(), "auth.json");

    try {
      const contents = await readFile(authPath, "utf8");
      const parsed = JSON.parse(contents);
      const tokens = isJsonRecord(parsed) && isJsonRecord(parsed.tokens) ? parsed.tokens : null;
      const accessToken =
        typeof tokens?.access_token === "string" ? tokens.access_token.trim() : "";
      const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";

      if (!accessToken || !accountId) {
        return null;
      }

      return {
        accessToken,
        accountId,
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }

      debugLog("app-server", "failed to read managed auth for wham proxy", {
        error: normalizeError(error).message,
        path: authPath,
      });
      return null;
    }
  }

  private readGlobalState(body: unknown): Record<string, unknown> {
    const key = isJsonRecord(body) && typeof body.key === "string" ? body.key : null;
    if (!key) {
      return {};
    }

    if (this.globalState.has(key)) {
      return {
        value: this.globalState.get(key),
      };
    }

    if (key === "thread-titles") {
      return {
        value: {},
      };
    }

    return {};
  }

  private async readCodexConfig(): Promise<unknown> {
    try {
      return await this.sendLocalRequest("config/read", {
        includeLayers: false,
        cwd: this.cwd,
      });
    } catch (error) {
      debugLog("app-server", "failed to read Codex config for host fetch", {
        error: normalizeError(error).message,
      });
      return {
        config: null,
      };
    }
  }

  private async handleLocalEnvironmentsRequest(body: unknown): Promise<unknown> {
    const workspaceRoot =
      readLocalEnvironmentWorkspaceRoot(body) ?? this.activeWorkspaceRoot ?? this.cwd;
    return await listLocalEnvironments(workspaceRoot);
  }

  private async handleLocalEnvironmentConfigRequest(body: unknown): Promise<unknown> {
    const configPath = readLocalEnvironmentConfigPath(body);
    if (configPath) {
      return await readLocalEnvironmentConfig(configPath);
    }

    const workspaceRoot = readLocalEnvironmentWorkspaceRoot(body) ?? this.activeWorkspaceRoot;
    if (!workspaceRoot) {
      throw new Error("Local environment workspace root is required.");
    }

    return await readLocalEnvironmentConfig(
      join(workspaceRoot, ".codex", "environments", "environment.toml"),
    );
  }

  private async handleLocalEnvironmentRequest(body: unknown): Promise<unknown> {
    const configPath = readLocalEnvironmentConfigPath(body);
    if (!configPath) {
      throw new Error("Local environment config path is required.");
    }

    return await loadLocalEnvironment(configPath);
  }

  private async handleLocalEnvironmentConfigSaveRequest(body: unknown): Promise<unknown> {
    const configPath = readLocalEnvironmentConfigPath(body);
    if (!configPath) {
      throw new Error("Local environment config path is required.");
    }

    const raw = readLocalEnvironmentRaw(body);
    if (raw === null) {
      throw new Error("Local environment config contents are required.");
    }

    return await saveLocalEnvironmentConfig(configPath, raw);
  }

  private async readCodexAgentsMarkdown(): Promise<{
    path: string;
    contents: string;
  }> {
    const path = resolveCodexAgentsMarkdownPath();

    try {
      return {
        path,
        contents: await readFile(path, "utf8"),
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return {
          path,
          contents: "",
        };
      }

      throw error;
    }
  }

  private async writeCodexAgentsMarkdown(body: unknown): Promise<{
    path: string;
  }> {
    const contents = readCodexAgentsMarkdownContents(body);
    if (contents === null) {
      throw new Error("Missing agents.md contents.");
    }

    const path = resolveCodexAgentsMarkdownPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
    return {
      path,
    };
  }

  private readDeveloperInstructions(body: unknown): string | null {
    if (!isJsonRecord(body)) {
      return null;
    }

    const params = isJsonRecord(body.params) ? body.params : body;
    return typeof params.baseInstructions === "string" ? params.baseInstructions : null;
  }

  private sanitizeMcpParams(method: string, params: unknown): unknown {
    if (!isJsonRecord(params)) {
      return params;
    }

    switch (method) {
      case "thread/start":
        return this.sanitizeThreadStartParams(params);
      case "thread/resume":
        return this.sanitizeThreadResumeParams(params);
      default:
        return params;
    }
  }

  private sanitizeThreadStartParams(params: JsonRecord): JsonRecord {
    const sanitized: JsonRecord = {
      ...params,
    };
    const config = isJsonRecord(params.config) ? params.config : null;

    if (typeof sanitized.model !== "string" && config && typeof config.model === "string") {
      sanitized.model = config.model;
    }

    delete sanitized.config;
    delete sanitized.modelProvider;

    return sanitized;
  }

  private sanitizeThreadResumeParams(params: JsonRecord): JsonRecord {
    const sanitized: JsonRecord = {};

    if (typeof params.threadId === "string") {
      sanitized.threadId = params.threadId;
    }
    if (typeof params.cwd === "string") {
      sanitized.cwd = params.cwd;
    }
    if (typeof params.personality === "string") {
      sanitized.personality = params.personality;
    }
    if (typeof params.model === "string") {
      sanitized.model = params.model;
    }
    if (typeof params.persistExtendedHistory === "boolean") {
      sanitized.persistExtendedHistory = params.persistExtendedHistory;
    }

    return sanitized;
  }

  private writeGlobalState(body: unknown): Record<string, never> {
    if (!isJsonRecord(body) || typeof body.key !== "string") {
      return {};
    }

    this.globalState.set(body.key, body.value);
    if (body.key === "pinned-thread-ids" && Array.isArray(body.value)) {
      this.pinnedThreadIds.clear();
      for (const value of body.value) {
        if (typeof value === "string") {
          this.pinnedThreadIds.add(value);
        }
      }
      this.emitBridgeMessage({
        type: "pinned-threads-updated",
      });
    }
    return {};
  }

  private setThreadPinned(body: unknown): Record<string, never> {
    if (!isJsonRecord(body)) {
      return {};
    }

    const threadId =
      typeof body.threadId === "string"
        ? body.threadId
        : typeof body.conversationId === "string"
          ? body.conversationId
          : null;
    if (!threadId) {
      return {};
    }

    if (body.pinned === false) {
      this.pinnedThreadIds.delete(threadId);
    } else {
      this.pinnedThreadIds.add(threadId);
    }

    this.globalState.set("pinned-thread-ids", Array.from(this.pinnedThreadIds));
    this.emitBridgeMessage({
      type: "pinned-threads-updated",
    });
    return {};
  }

  private setPinnedThreadsOrder(body: unknown): Record<string, never> {
    if (!isJsonRecord(body) || !Array.isArray(body.threadIds)) {
      return {};
    }

    const ordered = body.threadIds.filter((value): value is string => typeof value === "string");
    const remaining = Array.from(this.pinnedThreadIds).filter(
      (threadId) => !ordered.includes(threadId),
    );

    this.pinnedThreadIds.clear();
    for (const threadId of [...ordered, ...remaining]) {
      this.pinnedThreadIds.add(threadId);
    }

    this.globalState.set("pinned-thread-ids", Array.from(this.pinnedThreadIds));
    this.emitBridgeMessage({
      type: "pinned-threads-updated",
    });
    return {};
  }

  private async addWorkspaceRootOption(body: unknown): Promise<{ success: boolean; root: string }> {
    const root = isJsonRecord(body) && typeof body.root === "string" ? body.root : null;
    const label = isJsonRecord(body) && typeof body.label === "string" ? body.label : null;
    const setActive = !isJsonRecord(body) || body.setActive !== false;

    if (!root) {
      this.openWorkspaceRootPicker("manual");
      return {
        success: false,
        root: "",
      };
    }

    this.ensureWorkspaceRoot(root, {
      label,
      setActive,
    });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
    return {
      success: true,
      root,
    };
  }

  private applyWorkspaceRootRegistry(state: WorkspaceRootRegistryState): void {
    this.workspaceRoots.clear();
    this.workspaceRootLabels.clear();
    this.desktopImportPromptSeen = state.desktopImportPromptSeen;

    for (const root of state.roots) {
      this.workspaceRoots.add(root);
      const label = state.labels[root]?.trim();
      this.workspaceRootLabels.set(root, label || basename(root) || "Workspace");
    }

    this.activeWorkspaceRoot =
      state.activeRoot && this.workspaceRoots.has(state.activeRoot)
        ? state.activeRoot
        : (state.roots[0] ?? null);
  }

  private async persistWorkspaceRootRegistry(): Promise<void> {
    const roots = Array.from(this.workspaceRoots);
    try {
      const labels = Object.fromEntries(
        roots.flatMap((root) => {
          const label = this.workspaceRootLabels.get(root)?.trim();
          return label ? [[root, label] as const] : [];
        }),
      );
      await saveWorkspaceRootRegistry(this.workspaceRootRegistryPath, {
        roots,
        labels,
        activeRoot:
          this.activeWorkspaceRoot && this.workspaceRoots.has(this.activeWorkspaceRoot)
            ? this.activeWorkspaceRoot
            : (roots[0] ?? null),
        desktopImportPromptSeen: this.desktopImportPromptSeen,
      });
    } catch (error) {
      debugLog("app-server", "failed to persist workspace root registry", {
        error: normalizeError(error).message,
        path: this.workspaceRootRegistryPath,
      });
    }
  }

  private ensureWorkspaceRoot(
    root: string,
    options: { label?: string | null; setActive?: boolean } = {},
  ): void {
    this.workspaceRoots.add(root);
    const label = options.label?.trim();
    if (label) {
      this.workspaceRootLabels.set(root, label);
    } else if (!this.workspaceRootLabels.has(root)) {
      this.workspaceRootLabels.set(root, basename(root) || "Workspace");
    }

    if (options.setActive !== false) {
      this.activeWorkspaceRoot = root;
    }
  }

  private emitWorkspaceRootsUpdated(): void {
    this.syncWorkspaceGlobalState();
    this.emitBridgeMessage({
      type: "workspace-root-options-updated",
    });
    this.emitBridgeMessage({
      type: "active-workspace-roots-updated",
    });
  }

  private syncWorkspaceGlobalState(): void {
    this.globalState.set("pinned-thread-ids", Array.from(this.pinnedThreadIds));
    this.globalState.set("active-workspace-roots", this.getActiveWorkspaceRoots());
  }

  private getActiveWorkspaceRoots(): string[] {
    const roots = Array.from(this.workspaceRoots);
    if (roots.length === 0) {
      return [];
    }

    if (this.activeWorkspaceRoot && this.workspaceRoots.has(this.activeWorkspaceRoot)) {
      return [
        this.activeWorkspaceRoot,
        ...roots.filter((root) => root !== this.activeWorkspaceRoot),
      ];
    }

    return roots;
  }

  private getGitOriginFallbackDirectories(): string[] {
    const activeRoots = this.getActiveWorkspaceRoots();
    if (activeRoots.length > 0) {
      return activeRoots;
    }

    return this.cwd.length > 0 ? [this.cwd] : [];
  }

  private openWorkspaceRootPicker(context: WorkspaceRootPickerContext): void {
    this.emitBridgeMessage({
      type: "pocodex-open-workspace-root-picker",
      context,
      initialPath: homedir(),
    });
  }

  private async handleWorkspaceRootOptionPicked(message: JsonRecord): Promise<void> {
    const root = typeof message.root === "string" ? message.root : null;
    if (!root) {
      return;
    }

    try {
      await this.confirmWorkspaceRootSelection(root, "manual");
    } catch (error) {
      debugLog("app-server", "failed to apply workspace-root-option-picked", {
        error: normalizeError(error).message,
        root,
      });
    }
  }

  private async confirmWorkspaceRootSelection(
    path: string,
    context: WorkspaceRootPickerContext,
  ): Promise<{
    action: "activated" | "added";
    root: string;
  }> {
    const root = await this.resolveWorkspaceRootPickerDirectoryPath(
      {
        path,
      },
      {
        fallbackToHome: false,
        pathKey: "path",
      },
    );
    const action: "activated" | "added" = this.workspaceRoots.has(root) ? "activated" : "added";

    this.ensureWorkspaceRoot(root, {
      setActive: true,
    });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();

    if (context === "onboarding") {
      this.emitBridgeMessage({
        type: "electron-onboarding-pick-workspace-or-create-default-result",
        success: true,
      });
    }

    return {
      action,
      root,
    };
  }

  private readWorkspaceRootPickerContext(value: unknown): WorkspaceRootPickerContext {
    return value === "onboarding" ? "onboarding" : "manual";
  }

  private async resolveWorkspaceRootPickerDirectoryPath(
    params: unknown,
    options: {
      fallbackToHome: boolean;
      pathKey: string;
    },
  ): Promise<string> {
    const candidate =
      isJsonRecord(params) && typeof params[options.pathKey] === "string"
        ? (params[options.pathKey] as string)
        : null;
    const path = this.normalizeWorkspaceRootPickerPath(candidate, options.fallbackToHome);
    const stats = await stat(path).catch((error) => {
      throw normalizeWorkspaceRootPickerPathError(error);
    });
    if (!stats.isDirectory()) {
      throw new Error("Choose an existing folder.");
    }

    try {
      await readdir(path);
    } catch (error) {
      throw normalizeWorkspaceRootPickerPathError(error);
    }

    return path;
  }

  private normalizeWorkspaceRootPickerPath(
    candidate: string | null,
    fallbackToHome: boolean,
  ): string {
    const trimmedPath = candidate?.trim() ?? "";
    const path =
      trimmedPath.length > 0
        ? expandWorkspaceRootPickerHome(trimmedPath)
        : fallbackToHome
          ? homedir()
          : "";
    if (!path) {
      throw new Error("Folder path is required.");
    }
    if (!isAbsolute(path)) {
      throw new Error("Folder path must be absolute.");
    }

    return resolve(path);
  }

  private getWorkspaceRootPickerParentPath(path: string): string | null {
    const parentPath = dirname(path);
    return parentPath === path ? null : parentPath;
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  private getSharedObjectKey(message: JsonRecord): string | null {
    const candidates = [message.key, message.name, message.objectKey, message.objectName];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
    return null;
  }

  private emitSharedObjectUpdate(key: string): void {
    const value = this.sharedObjects.has(key) ? this.sharedObjects.get(key) : null;
    this.emitBridgeMessage({
      type: "shared-object-updated",
      key,
      value,
    });
  }

  private buildHostConfig(): Record<string, string> {
    return {
      id: this.hostId,
      display_name: "Local",
      kind: "local",
    };
  }

  private emitFetchSuccess(
    requestId: string,
    body: unknown,
    status = 200,
    headers?: Record<string, string>,
  ): void {
    this.emit("bridge_message", {
      type: "fetch-response",
      requestId,
      responseType: "success",
      status,
      headers:
        headers && Object.keys(headers).length > 0
          ? headers
          : {
              "content-type": "application/json",
            },
      bodyJsonString: JSON.stringify(body),
    });
  }

  private emitFetchError(requestId: string, status: number, error: string): void {
    this.emit("bridge_message", {
      type: "fetch-response",
      requestId,
      responseType: "error",
      status,
      error,
    });
  }

  private emitBridgeMessage(message: JsonRecord): void {
    this.emit("bridge_message", message);
  }

  private sendJsonRpcMessage(message: JsonRecord): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async sendLocalRequestSafely(method: string, params?: unknown): Promise<unknown | null> {
    try {
      return await this.sendLocalRequest(method, params);
    } catch (error) {
      debugLog("app-server", "failed to handle local bridge request", {
        error: normalizeError(error).message,
        method,
      });
      return null;
    }
  }

  private async sendLocalRequest(method: string, params?: unknown): Promise<unknown> {
    const id = `pocodex-local-${++this.nextRequestId}`;
    return new Promise<unknown>((resolve, reject) => {
      this.localRequests.set(id, { resolve, reject });
      this.sendJsonRpcMessage({
        id,
        method,
        params,
      });
    });
  }

  private rejectPendingRequests(error: Error): void {
    this.localRequests.forEach(({ reject }) => reject(error));
    this.localRequests.clear();
  }

  private listExistingPaths(body: unknown): string[] {
    if (!isJsonRecord(body) || !Array.isArray(body.paths)) {
      return [];
    }

    return body.paths.filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && existsSync(value),
    );
  }
}

function buildIpcErrorResponse(requestId: string, error: string): JsonRecord {
  return {
    requestId,
    type: "response",
    resultType: "error",
    error,
  };
}

function buildIpcSuccessResponse(requestId: string, result: unknown): JsonRecord {
  return {
    requestId,
    type: "response",
    resultType: "success",
    result,
  };
}

async function resolveGitOrigins(
  body: unknown,
  fallbackDirs: string[],
): Promise<GitOriginsResponse> {
  const requestedDirs = readGitOriginDirectories(body);
  const dirs = requestedDirs.length > 0 ? requestedDirs : uniqueStrings(fallbackDirs);
  if (dirs.length === 0) {
    return {
      origins: [],
      homeDir: homedir(),
    };
  }

  const repositoriesByRoot = new Map<string, GitRepositoryInfo>();
  const originsByDir = new Map<string, GitOriginRecord>();

  for (const dir of dirs) {
    const origin = await resolveGitOrigin(dir, repositoriesByRoot);
    if (origin) {
      originsByDir.set(origin.dir, origin);
    }
  }

  for (const repository of repositoriesByRoot.values()) {
    const worktreeRoots = await listGitWorktreeRoots(repository.root);
    for (const worktreeRoot of worktreeRoots) {
      if (originsByDir.has(worktreeRoot)) {
        continue;
      }

      originsByDir.set(worktreeRoot, {
        dir: worktreeRoot,
        root: worktreeRoot,
        originUrl: repository.originUrl,
      });
    }
  }

  return {
    origins: Array.from(originsByDir.values()),
    homeDir: homedir(),
  };
}

async function resolveGitOrigin(
  dir: string,
  repositoriesByRoot: Map<string, GitRepositoryInfo>,
): Promise<GitOriginRecord | null> {
  const repository = await resolveGitRepository(dir, repositoriesByRoot);
  if (!repository) {
    return null;
  }

  return {
    dir,
    root: repository.root,
    originUrl: repository.originUrl,
  };
}

async function resolveGitRepository(
  dir: string,
  repositoriesByRoot: Map<string, GitRepositoryInfo>,
): Promise<GitRepositoryInfo | null> {
  let root: string;
  try {
    root = await runGitCommand(resolve(dir), ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }

  if (root.length === 0) {
    return null;
  }

  const existingRepository = repositoriesByRoot.get(root);
  if (existingRepository) {
    return existingRepository;
  }

  let originUrl: string | null;
  try {
    const configuredOriginUrl = await runGitCommand(root, ["config", "--get", "remote.origin.url"]);
    originUrl = configuredOriginUrl.length > 0 ? configuredOriginUrl : null;
  } catch {
    originUrl = null;
  }

  const repository: GitRepositoryInfo = {
    root,
    originUrl,
  };
  repositoriesByRoot.set(root, repository);
  return repository;
}

async function listGitWorktreeRoots(root: string): Promise<string[]> {
  try {
    const output = await runGitCommand(root, ["worktree", "list", "--porcelain"]);
    const worktreeRoots = output.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("worktree ")) {
        return [];
      }

      const worktreeRoot = line.slice("worktree ".length).trim();
      return worktreeRoot.length > 0 ? [worktreeRoot] : [];
    });
    return uniqueStrings([root, ...worktreeRoots]);
  } catch {
    return [root];
  }
}

function readGitOriginDirectories(body: unknown): string[] {
  const params = isJsonRecord(body) && isJsonRecord(body.params) ? body.params : body;
  if (!isJsonRecord(params) || !Array.isArray(params.dirs)) {
    return [];
  }

  return uniqueStrings(params.dirs);
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
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

function extractJsonRpcErrorMessage(error: unknown): string {
  if (isJsonRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readUsageVisibilityPlanFromAccount(result: unknown): UsageVisibilityPlan | null {
  const account = isJsonRecord(result) && isJsonRecord(result.account) ? result.account : null;
  return normalizeUsageVisibilityPlan(account?.planType);
}

function normalizeUsageVisibilityPlan(planType: unknown): UsageVisibilityPlan | null {
  switch (planType) {
    case "plus":
    case "pro":
    case "prolite":
      return planType;
    default:
      return null;
  }
}

function buildWhamUsagePayload(result: unknown): WhamUsagePayload {
  const emptyPayload = buildEmptyWhamUsagePayload();
  if (!isJsonRecord(result)) {
    return emptyPayload;
  }

  const rateLimits = normalizeLocalRateLimitSnapshot(result.rateLimits);
  if (!hasLocalRateLimitSnapshotData(rateLimits)) {
    return emptyPayload;
  }

  const additionalRateLimits = isJsonRecord(result.rateLimitsByLimitId)
    ? Object.entries(result.rateLimitsByLimitId).flatMap(([limitId, snapshot]) =>
        normalizeLimitId(limitId) === USAGE_CORE_LIMIT_ID
          ? []
          : buildAdditionalWhamRateLimitPayload(snapshot),
      )
    : [];

  return {
    credits: buildWhamCreditsPayload(rateLimits.credits),
    plan_type: rateLimits.planType,
    rate_limit_name: rateLimits.limitName,
    rate_limit: buildWhamRateLimitPayload(rateLimits),
    additional_rate_limits: additionalRateLimits,
  };
}

function buildEmptyWhamUsagePayload(): WhamUsagePayload {
  return {
    credits: null,
    plan_type: null,
    rate_limit_name: null,
    rate_limit: null,
    additional_rate_limits: [],
  };
}

function buildAdditionalWhamRateLimitPayload(snapshot: unknown): WhamAdditionalRateLimitPayload[] {
  const normalizedSnapshot = normalizeLocalRateLimitSnapshot(snapshot);
  if (!hasLocalRateLimitSnapshotData(normalizedSnapshot)) {
    return [];
  }

  return [
    {
      limit_name: normalizedSnapshot.limitName,
      rate_limit: buildWhamRateLimitPayload(normalizedSnapshot),
    },
  ];
}

function buildWhamCreditsPayload(
  credits: LocalCreditsSnapshot | null,
): WhamUsagePayload["credits"] {
  if (!credits) {
    return null;
  }

  return {
    has_credits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance,
  };
}

function buildWhamRateLimitPayload(snapshot: LocalRateLimitSnapshot): WhamUsageRateLimitPayload {
  const limitReached = isLocalRateLimitReached(snapshot);
  return {
    primary_window: buildWhamWindowPayload(snapshot.primary),
    secondary_window: buildWhamWindowPayload(snapshot.secondary),
    limit_reached: limitReached,
    allowed: !limitReached,
  };
}

function buildWhamWindowPayload(
  window: LocalRateLimitWindowSnapshot | null,
): WhamUsageWindowPayload | null {
  if (!window) {
    return null;
  }

  return {
    used_percent: window.usedPercent,
    limit_window_seconds:
      window.windowDurationMins === null ? null : Math.round(window.windowDurationMins * 60),
    reset_at: window.resetsAt,
  };
}

function isLocalRateLimitReached(snapshot: LocalRateLimitSnapshot): boolean {
  return [snapshot.primary, snapshot.secondary].some(
    (window) => window !== null && window.usedPercent !== null && window.usedPercent >= 100,
  );
}

function hasLocalRateLimitSnapshotData(
  snapshot: LocalRateLimitSnapshot | null,
): snapshot is LocalRateLimitSnapshot {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.limitId !== null ||
    snapshot.limitName !== null ||
    snapshot.primary !== null ||
    snapshot.secondary !== null ||
    snapshot.credits !== null ||
    snapshot.planType !== null
  );
}

function normalizeLocalRateLimitSnapshot(value: unknown): LocalRateLimitSnapshot | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  return {
    limitId: readOptionalString(value.limitId),
    limitName: readOptionalString(value.limitName),
    primary: normalizeLocalRateLimitWindowSnapshot(value.primary),
    secondary: normalizeLocalRateLimitWindowSnapshot(value.secondary),
    credits: normalizeLocalCreditsSnapshot(value.credits),
    planType: readOptionalString(value.planType),
  };
}

function normalizeLocalRateLimitWindowSnapshot(
  value: unknown,
): LocalRateLimitWindowSnapshot | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  return {
    usedPercent: readOptionalNumber(value.usedPercent),
    windowDurationMins: readOptionalNumber(value.windowDurationMins),
    resetsAt: readOptionalNumber(value.resetsAt),
  };
}

function normalizeLocalCreditsSnapshot(value: unknown): LocalCreditsSnapshot | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  return {
    hasCredits: readOptionalBoolean(value.hasCredits),
    unlimited: readOptionalBoolean(value.unlimited),
    balance: readOptionalString(value.balance),
  };
}

function normalizeLimitId(limitId: string): string {
  return limitId.trim().toLowerCase();
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseResponseBody(bodyText: string): unknown {
  if (!bodyText) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

async function readRemoteFetchResponse(response: Response): Promise<RelativeFetchResponse> {
  const bodyText = await response.text();
  return {
    status: response.status,
    headers: readResponseHeaders(response.headers),
    body: parseResponseBody(bodyText),
  };
}

function readResponseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!isJsonRecord(headers)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function buildOutboundFetchHeaders(
  headers: unknown,
  body: unknown,
): Record<string, string> | undefined {
  const normalized = normalizeHeaders(headers) ?? {};

  if (shouldInferJsonContentType(normalized, body)) {
    normalized["content-type"] = "application/json";
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function shouldInferJsonContentType(headers: Record<string, string>, body: unknown): boolean {
  if (typeof body !== "string") {
    return false;
  }

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-type") {
      return false;
    }
  }

  const parsed = parseJsonBody(body);
  return parsed !== null && typeof parsed === "object";
}

function normalizeRequestBody(body: unknown): BodyInit | undefined {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body === null || body === undefined) {
    return undefined;
  }
  return JSON.stringify(body);
}

function expandWorkspaceRootPickerHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function normalizeWorkspaceRootPickerPathError(error: unknown): Error {
  if (isJsonRecord(error) && error.code === "ENOENT") {
    return new Error("Choose an existing folder.");
  }
  if (isJsonRecord(error) && error.code === "EACCES") {
    return new Error("That folder is not readable.");
  }
  if (isJsonRecord(error) && error.code === "ENOTDIR") {
    return new Error("Choose an existing folder.");
  }

  return normalizeError(error);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveCodexAgentsMarkdownPath(): string {
  return join(deriveCodexHomePath(), "agents.md");
}

function readCodexAgentsMarkdownContents(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  if (!isJsonRecord(params) || typeof params.contents !== "string") {
    return null;
  }

  return params.contents;
}

function readLocalEnvironmentWorkspaceRoot(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  return isJsonRecord(params) && typeof params.workspaceRoot === "string"
    ? params.workspaceRoot
    : null;
}

function readLocalEnvironmentConfigPath(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  return isJsonRecord(params) && typeof params.configPath === "string" ? params.configPath : null;
}

function readLocalEnvironmentRaw(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  return isJsonRecord(params) && typeof params.raw === "string" ? params.raw : null;
}

function readCodexFetchParams(body: unknown): unknown {
  if (!isJsonRecord(body)) {
    return body;
  }

  return isJsonRecord(body.params) ? body.params : body;
}

function isFileNotFoundError(error: unknown): boolean {
  return isJsonRecord(error) && error.code === "ENOENT";
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
