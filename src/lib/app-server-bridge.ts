import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  codexHomePath?: string;
  persistedAtomRegistryPath?: string;
  workspaceRootRegistryPath?: string;
  gitWorkerBridge?: CodexDesktopGitWorkerBridge;
  codexCliPath?: string;
}

interface WhamUsageCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance: number | null;
}

interface WhamUsageWindow {
  used_percent: number;
  limit_window_seconds: number | null;
  reset_at: number | null;
}

interface WhamUsageRateLimit {
  allowed: boolean;
  limit_reached: boolean;
  rate_limit_name: string | null;
  primary_window: WhamUsageWindow | null;
  secondary_window: WhamUsageWindow | null;
}

interface WhamUsageAdditionalRateLimit {
  limit_name: string;
  rate_limit: WhamUsageRateLimit;
}

interface WhamUsageResponse {
  credits: WhamUsageCredits | null;
  plan_type: string | null;
  rate_limit: WhamUsageRateLimit | null;
  additional_rate_limits: WhamUsageAdditionalRateLimit[];
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

type PendingWorktreePhase = "queued" | "creating" | "worktree-ready" | "failed";
type PendingWorktreeLaunchMode =
  | "create-stable-worktree"
  | "fork-conversation"
  | "start-conversation";

interface PendingWorktreeEntry {
  id: string;
  hostId: string;
  createdAt: number;
  phase: PendingWorktreePhase;
  labelEdited: boolean;
  outputText: string;
  errorMessage: string | null;
  worktreeWorkspaceRoot: string | null;
  worktreeGitRoot: string | null;
  needsAttention: boolean;
  isPinned: boolean;
  label: string;
  sourceWorkspaceRoot: string;
  startingState: JsonRecord;
  localEnvironmentConfigPath: string | null;
  prompt: string;
  launchMode: PendingWorktreeLaunchMode;
  startConversationParamsInput: unknown;
  sourceConversationId: string | null;
  sourceCollaborationMode: string | null;
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

interface GhCliStatus {
  isInstalled: boolean;
  isAuthenticated: boolean;
}

interface GhPrStatus {
  status: string;
  hasOpenPr: boolean;
  isDraft: boolean;
  canMerge: boolean;
  ciStatus: string | null;
  url: string | null;
}

interface GhPrInfo {
  state: string | null;
  isDraft: boolean;
  mergeable: string | null;
  url: string | null;
  statusCheckRollup: unknown;
}

interface RecommendedSkill {
  id: string;
  name: string;
  description: string;
  shortDescription: string | null;
  repoPath: string;
  path: string;
  iconSmall?: string;
  iconLarge?: string;
}

interface RecommendedSkillsResponse {
  repoRoot: string;
  skills: RecommendedSkill[];
  error?: string;
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
  private readonly pendingMcpRequestMethods = new Map<string, string>();
  private readonly fetchRequests = new Map<string, AbortController>();
  private readonly pendingWorktreeRequests = new Map<string, AbortController>();
  private readonly persistedAtoms = new Map<string, unknown>();
  private readonly globalState = new Map<string, unknown>();
  private readonly pinnedThreadIds = new Set<string>();
  private readonly sharedObjects = new Map<string, unknown>();
  private readonly sharedObjectSubscriptions = new Set<string>();
  private readonly workspaceRoots = new Set<string>();
  private readonly workspaceRootLabels = new Map<string, string>();
  private readonly codexHomePath: string;
  private persistedAtomRegistryPath: string;
  private workspaceRootRegistryPath: string;
  private readonly gitWorkerBridge: CodexDesktopGitWorkerBridge;
  private activeWorkspaceRoot: string | null;
  private desktopImportPromptSeen = false;
  private persistedAtomWritePromise: Promise<void> = Promise.resolve();
  private nextRequestId = 0;
  private isClosing = false;
  private isInitialized = false;
  private childExited = false;
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
    this.codexHomePath = options.codexHomePath ?? deriveCodexHomePath();
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
    this.sharedObjects.set("pending_worktrees", []);
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
      env: {
        ...process.env,
        CODEX_HOME: this.codexHomePath,
      },
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
    this.pendingWorktreeRequests.forEach((controller) => controller.abort());
    this.pendingWorktreeRequests.clear();
    this.terminalManager.dispose();
    await this.gitWorkerBridge.close().catch((error) => {
      debugLog("git-worker", "failed to close desktop git worker bridge", {
        error: normalizeError(error).message,
      });
    });

    if (!this.childExited) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          this.child.off("exit", settle);
          resolve();
        };

        this.child.once("exit", settle);
        timer = setTimeout(settle, 1_000);

        if (!this.child.killed) {
          this.child.kill();
        }
      });
    }

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
      case "thread-archived":
      case "thread-unarchived":
      case "thread-queued-followups-changed":
      case "serverRequest/resolved":
        return;
      case "thread-stream-state-changed":
        this.emitBridgeMessage(message);
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
      case "pending-worktree-create":
        await this.handlePendingWorktreeCreate(message);
        return;
      case "pending-worktree-update-metadata":
        this.handlePendingWorktreeUpdateMetadata(message);
        return;
      case "pending-worktree-retry":
        await this.handlePendingWorktreeRetry(message);
        return;
      case "pending-worktree-cancel":
        this.handlePendingWorktreeCancel(message);
        return;
      case "pending-worktree-dismiss":
        this.handlePendingWorktreeDismiss(message);
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

  private async sendGitWorkerRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    onGitWorkerMessage?: (message: JsonRecord) => void,
  ): Promise<unknown> {
    const requestId = randomUUID();

    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.off("worker_message", onWorkerMessage);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const onWorkerMessage = (workerName: string, message: unknown) => {
        if (workerName !== "git" || !isJsonRecord(message)) {
          return;
        }

        onGitWorkerMessage?.(message);

        if (message.type !== "worker-response") {
          return;
        }

        const response = isJsonRecord(message.response) ? message.response : null;
        if (
          !response ||
          (typeof response.id !== "string" && typeof response.id !== "number") ||
          String(response.id) !== requestId ||
          response.method !== method
        ) {
          return;
        }

        const result = isJsonRecord(response.result) ? response.result : null;
        if (!result || result.type !== "ok") {
          const workerError = result && isJsonRecord(result.error) ? result.error : null;
          settle(() => {
            reject(
              new Error(
                typeof workerError?.message === "string" && workerError.message.trim().length > 0
                  ? workerError.message
                  : `Git worker request "${method}" failed.`,
              ),
            );
          });
          return;
        }

        settle(() => {
          resolve(result.value);
        });
      };

      const onAbort = () => {
        const error = new Error(`Git worker request "${method}" was aborted.`);
        error.name = "AbortError";
        void this.gitWorkerBridge
          .send({
            type: "worker-request-cancel",
            workerId: "git",
            id: requestId,
          })
          .catch(() => {});
        settle(() => {
          reject(error);
        });
      };

      if (signal?.aborted) {
        const error = new Error(`Git worker request "${method}" was aborted.`);
        error.name = "AbortError";
        settle(() => {
          reject(error);
        });
        return;
      }

      this.on("worker_message", onWorkerMessage);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.gitWorkerBridge
        .send({
          type: "worker-request",
          workerId: "git",
          request: {
            id: requestId,
            method,
            params,
          },
        })
        .catch((error) => {
          settle(() => {
            reject(error);
          });
        });
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
        case "workspace-root-browser/list":
          return buildIpcSuccessResponse(
            requestId,
            await this.listWorkspaceRootBrowserDirectory(payload.params),
          );
        case "workspace-root-option/add":
          return buildIpcSuccessResponse(
            requestId,
            await this.addWorkspaceRootOption(payload.params),
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
      this.childExited = true;
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
      this.syncPendingWorktreesSharedObject();
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

  private async listWorkspaceRootBrowserDirectory(params: unknown): Promise<{
    root: string;
    parentRoot: string | null;
    homeDir: string;
    entries: Array<{
      name: string;
      path: string;
    }>;
  }> {
    const homeDir = homedir();
    const requestedRoot =
      isJsonRecord(params) && typeof params.root === "string" ? params.root.trim() : "";
    const root = this.normalizeWorkspaceRootPickerPath(requestedRoot || null, true);
    const rootValidationError = await this.getWorkspaceRootValidationError(root);
    if (rootValidationError) {
      throw new Error(rootValidationError);
    }

    const dirents = await readdir(root, {
      withFileTypes: true,
    });
    const entries: Array<{
      name: string;
      path: string;
    }> = [];

    for (const dirent of dirents) {
      const entryPath = join(root, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({
          name: dirent.name,
          path: entryPath,
        });
        continue;
      }

      if (!dirent.isSymbolicLink()) {
        continue;
      }

      try {
        if ((await stat(entryPath)).isDirectory()) {
          entries.push({
            name: dirent.name,
            path: entryPath,
          });
        }
      } catch {
        // Ignore broken or inaccessible symlinks in the browser listing.
      }
    }

    entries.sort((left, right) => compareWorkspaceRootBrowserEntries(left, right));

    const parentRootCandidate = resolve(root, "..");
    return {
      root,
      parentRoot: parentRootCandidate === root ? null : parentRootCandidate,
      homeDir,
      entries,
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
      await this.handleJsonRpcResponse(message);
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

  private async handleJsonRpcResponse(message: JsonRecord): Promise<void> {
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

    const requestMethod = id ? (this.pendingMcpRequestMethods.get(id) ?? null) : null;
    if (id) {
      this.pendingMcpRequestMethods.delete(id);
    }

    let normalizedResult = message.result;
    if (message.error === undefined && requestMethod) {
      try {
        normalizedResult = await this.normalizeForwardedMcpResult(requestMethod, message.result);
      } catch (error) {
        debugLog("app-server", "failed to normalize forwarded MCP result", {
          error: normalizeError(error).message,
          method: requestMethod,
        });
      }
    }

    this.emit("bridge_message", {
      type: "mcp-response",
      hostId: this.hostId,
      message: {
        id: message.id,
        ...(message.error !== undefined ? { error: message.error } : { result: normalizedResult }),
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

    if (message.request.id !== undefined) {
      this.pendingMcpRequestMethods.set(String(message.request.id), message.request.method);
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

  private async normalizeForwardedMcpResult(method: string, result: unknown): Promise<unknown> {
    switch (method) {
      case "plugin/list":
        return this.normalizePluginListResult(result);
      case "plugin/read":
        return this.normalizePluginReadResult(result);
      default:
        return result;
    }
  }

  private async normalizePluginListResult(result: unknown): Promise<unknown> {
    if (!isJsonRecord(result) || !Array.isArray(result.marketplaces)) {
      return result;
    }

    const marketplaces = await Promise.all(
      result.marketplaces.map(async (marketplace) => {
        if (!isJsonRecord(marketplace) || !Array.isArray(marketplace.plugins)) {
          return marketplace;
        }

        return {
          ...marketplace,
          plugins: await Promise.all(
            marketplace.plugins.map((plugin) => this.normalizePluginSummary(plugin)),
          ),
        };
      }),
    );

    return {
      ...result,
      marketplaces,
    };
  }

  private async normalizePluginReadResult(result: unknown): Promise<unknown> {
    if (!isJsonRecord(result) || !isJsonRecord(result.plugin)) {
      return result;
    }

    const plugin = result.plugin;
    const normalizedSummary = await this.normalizePluginSummary(plugin.summary);
    const pluginRoot = this.getLocalPluginRoot(normalizedSummary);
    const normalizedSkills = Array.isArray(plugin.skills)
      ? await Promise.all(
          plugin.skills.map((skill) => this.normalizePluginSkillSummary(skill, pluginRoot)),
        )
      : plugin.skills;

    return {
      ...result,
      plugin: {
        ...plugin,
        summary: normalizedSummary,
        ...(Array.isArray(plugin.skills) ? { skills: normalizedSkills } : {}),
      },
    };
  }

  private async normalizePluginSummary(summary: unknown): Promise<unknown> {
    if (!isJsonRecord(summary)) {
      return summary;
    }

    const pluginRoot = this.getLocalPluginRoot(summary);
    return {
      ...summary,
      interface: await this.normalizePluginInterface(summary.interface, [pluginRoot]),
    };
  }

  private async normalizePluginInterface(
    value: unknown,
    basePaths: Array<string | null>,
  ): Promise<unknown> {
    if (!isJsonRecord(value)) {
      return value;
    }

    const screenshots = Array.isArray(value.screenshots)
      ? (
          await Promise.all(
            value.screenshots.map((screenshot) =>
              this.normalizeImageAssetField(screenshot, basePaths),
            ),
          )
        ).filter((screenshot): screenshot is string => typeof screenshot === "string")
      : value.screenshots;

    return {
      ...value,
      logo: await this.normalizeImageAssetField(value.logo, basePaths),
      composerIcon: await this.normalizeImageAssetField(value.composerIcon, basePaths),
      ...(Array.isArray(value.screenshots) ? { screenshots } : {}),
    };
  }

  private async normalizePluginSkillSummary(
    summary: unknown,
    pluginRoot: string | null,
  ): Promise<unknown> {
    if (!isJsonRecord(summary)) {
      return summary;
    }

    const basePaths: Array<string | null> = [pluginRoot];
    if (typeof summary.path === "string") {
      if (pluginRoot && !isAbsolute(summary.path)) {
        basePaths.unshift(resolve(pluginRoot, summary.path));
      } else {
        basePaths.unshift(summary.path);
      }
    }

    return {
      ...summary,
      interface: await this.normalizeSkillInterface(summary.interface, basePaths),
    };
  }

  private async normalizeSkillInterface(
    value: unknown,
    basePaths: Array<string | null>,
  ): Promise<unknown> {
    if (!isJsonRecord(value)) {
      return value;
    }

    return {
      ...value,
      iconSmall: await this.normalizeImageAssetField(value.iconSmall, basePaths),
      iconLarge: await this.normalizeImageAssetField(value.iconLarge, basePaths),
    };
  }

  private getLocalPluginRoot(summary: unknown): string | null {
    if (!isJsonRecord(summary) || !isJsonRecord(summary.source)) {
      return null;
    }

    return summary.source.type === "local" && typeof summary.source.path === "string"
      ? summary.source.path
      : null;
  }

  private async normalizeImageAssetField(
    value: unknown,
    basePaths: Array<string | null>,
  ): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "string") {
      return value;
    }

    return await renderableImageUrlFromPath(value, basePaths);
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

    if (message.url === "/wham/usage") {
      debugLog("status", "received /wham/usage fetch", {
        requestId: message.requestId,
        method: typeof message.method === "string" ? message.method : "GET",
      });
    }

    const controller = new AbortController();
    this.fetchRequests.set(message.requestId, controller);

    try {
      if (message.url === "vscode://codex/ipc-request") {
        const payload = parseJsonBody(message.body);
        const result = await this.handleIpcRequest(payload);
        if (controller.signal.aborted) {
          return;
        }
        this.emitFetchSuccess(message.requestId, result);
        return;
      }

      if (message.url.startsWith("vscode://codex/")) {
        const body = parseJsonBody(message.body);
        const handled = await this.handleCodexFetchRequest(
          message.url,
          typeof message.method === "string" ? message.method : "GET",
          body,
          controller.signal,
        );
        if (controller.signal.aborted) {
          return;
        }
        if (handled) {
          if (handled.status < 200 || handled.status >= 300) {
            this.emitFetchError(
              message.requestId,
              handled.status,
              readFetchErrorMessage(
                handled.body,
                `Codex host fetch failed for ${new URL(message.url).pathname}.`,
              ),
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
        if (controller.signal.aborted) {
          return;
        }
        if (handled) {
          this.emitFetchSuccess(message.requestId, handled.body, handled.status, handled.headers);
          if (message.url === "/wham/usage") {
            debugLog(
              "status",
              "served local /wham/usage response",
              summarizeWhamUsageResponse(handled.body),
            );
          }
          return;
        }

        const response = await fetch(new URL(message.url, "https://chatgpt.com"), {
          method: typeof message.method === "string" ? message.method : "GET",
          headers: buildOutboundFetchHeaders(message.headers, message.body),
          body: normalizeRequestBody(message.body),
          signal: controller.signal,
        });
        const handledResponse = await readRemoteFetchResponse(response);
        if (controller.signal.aborted) {
          return;
        }

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
      if (controller.signal.aborted) {
        return;
      }

      this.emit("bridge_message", {
        type: "fetch-response",
        requestId: message.requestId,
        responseType: "success",
        status: handledResponse.status,
        headers: handledResponse.headers,
        bodyJsonString: JSON.stringify(handledResponse.body),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
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

    if (message.key === "pending_worktrees") {
      this.syncPendingWorktreesSharedObject();
    }

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

  private async handlePendingWorktreeCreate(message: JsonRecord): Promise<void> {
    if (!this.isMessageForThisHost(message.hostId)) {
      return;
    }

    const entry = parsePendingWorktreeEntryRequest(message.request, this.hostId);
    if (!entry) {
      return;
    }

    this.upsertPendingWorktree(entry);
    void this.startPendingWorktreeCreation(entry.id);
  }

  private handlePendingWorktreeUpdateMetadata(message: JsonRecord): void {
    if (!this.isMessageForThisHost(message.hostId) || typeof message.id !== "string") {
      return;
    }

    const update = parsePendingWorktreeMetadataUpdate(message.update);
    if (!update) {
      return;
    }

    this.updatePendingWorktree(message.id, (entry) => {
      switch (update.type) {
        case "isPinned":
          return {
            ...entry,
            isPinned: update.isPinned,
          };
        case "label":
          return {
            ...entry,
            label: update.label,
          };
        case "labelEdited":
          return {
            ...entry,
            labelEdited: update.labelEdited,
          };
        case "needsAttention":
          return {
            ...entry,
            needsAttention: update.needsAttention,
          };
      }
    });
  }

  private async handlePendingWorktreeRetry(message: JsonRecord): Promise<void> {
    if (!this.isMessageForThisHost(message.hostId) || typeof message.id !== "string") {
      return;
    }

    this.updatePendingWorktree(message.id, (entry) => ({
      ...entry,
      phase: "queued",
      outputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
    }));
    void this.startPendingWorktreeCreation(message.id);
  }

  private handlePendingWorktreeCancel(message: JsonRecord): void {
    if (!this.isMessageForThisHost(message.hostId) || typeof message.id !== "string") {
      return;
    }

    this.pendingWorktreeRequests.get(message.id)?.abort();
    this.pendingWorktreeRequests.delete(message.id);
    this.removePendingWorktree(message.id);
  }

  private handlePendingWorktreeDismiss(message: JsonRecord): void {
    if (!this.isMessageForThisHost(message.hostId) || typeof message.id !== "string") {
      return;
    }

    this.pendingWorktreeRequests.get(message.id)?.abort();
    this.pendingWorktreeRequests.delete(message.id);
    this.removePendingWorktree(message.id);
  }

  private async startPendingWorktreeCreation(id: string): Promise<void> {
    const entry = this.findPendingWorktree(id);
    if (!entry) {
      return;
    }

    this.pendingWorktreeRequests.get(id)?.abort();
    const controller = new AbortController();
    this.pendingWorktreeRequests.set(id, controller);
    this.updatePendingWorktree(id, (currentEntry) => ({
      ...currentEntry,
      phase: "creating",
      outputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
    }));

    try {
      const result = (await this.sendGitWorkerRequest(
        "create-worktree",
        {
          cwd: entry.sourceWorkspaceRoot,
          startingState: entry.startingState,
          localEnvironmentConfigPath: entry.localEnvironmentConfigPath ?? undefined,
          streamId: entry.id,
        },
        controller.signal,
        (message) => {
          const event = readPendingWorktreeWorkerEvent(message, entry.id);
          if (!event) {
            return;
          }

          if (event.type === "path") {
            this.updatePendingWorktree(id, (currentEntry) => ({
              ...currentEntry,
              worktreeGitRoot: event.worktreeGitRoot,
            }));
            return;
          }

          if (event.text.length === 0) {
            return;
          }
          this.updatePendingWorktree(id, (currentEntry) => ({
            ...currentEntry,
            outputText: `${currentEntry.outputText}${event.text}`,
          }));
        },
      )) as {
        worktreeGitRoot?: unknown;
        worktreeWorkspaceRoot?: unknown;
      };

      const worktreeGitRoot =
        typeof result.worktreeGitRoot === "string" ? result.worktreeGitRoot : null;
      const worktreeWorkspaceRoot =
        typeof result.worktreeWorkspaceRoot === "string" ? result.worktreeWorkspaceRoot : null;
      if (!worktreeGitRoot || !worktreeWorkspaceRoot) {
        throw new Error("Git worker returned an invalid create-worktree result.");
      }

      this.updatePendingWorktree(id, (currentEntry) => ({
        ...currentEntry,
        phase: "worktree-ready",
        worktreeGitRoot,
        worktreeWorkspaceRoot,
        errorMessage: null,
        needsAttention: false,
      }));

      if (entry.launchMode === "create-stable-worktree") {
        this.ensureWorkspaceRoot(worktreeWorkspaceRoot, {
          setActive: true,
          label: entry.label.trim() || basename(worktreeWorkspaceRoot) || "Workspace",
        });
        await this.persistWorkspaceRootRegistry();
        this.emitWorkspaceRootsUpdated();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      this.updatePendingWorktree(id, (currentEntry) => ({
        ...currentEntry,
        phase: "failed",
        errorMessage: normalizeError(error).message,
        needsAttention: true,
      }));
    } finally {
      if (this.pendingWorktreeRequests.get(id) === controller) {
        this.pendingWorktreeRequests.delete(id);
      }
    }
  }

  private isMessageForThisHost(hostId: unknown): boolean {
    return typeof hostId !== "string" || hostId === this.hostId;
  }

  private findPendingWorktree(id: string): PendingWorktreeEntry | null {
    return this.readPendingWorktrees().find((entry) => entry.id === id) ?? null;
  }

  private readPendingWorktrees(): PendingWorktreeEntry[] {
    const value = this.persistedAtoms.get("pending_worktrees");
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(isPendingWorktreeEntry);
  }

  private writePendingWorktrees(entries: PendingWorktreeEntry[]): void {
    this.handlePersistedAtomUpdate({
      type: "persisted-atom-update",
      key: "pending_worktrees",
      value: entries,
    });
  }

  private upsertPendingWorktree(entry: PendingWorktreeEntry): void {
    const entries = this.readPendingWorktrees().filter(
      (currentEntry) => currentEntry.id !== entry.id,
    );
    entries.push(entry);
    this.writePendingWorktrees(entries);
  }

  private removePendingWorktree(id: string): void {
    const entries = this.readPendingWorktrees().filter((entry) => entry.id !== id);
    this.writePendingWorktrees(entries);
  }

  private updatePendingWorktree(
    id: string,
    update: (entry: PendingWorktreeEntry) => PendingWorktreeEntry,
  ): PendingWorktreeEntry | null {
    let nextEntry: PendingWorktreeEntry | null = null;
    const entries = this.readPendingWorktrees().map((entry) => {
      if (entry.id !== id) {
        return entry;
      }

      nextEntry = update(entry);
      return nextEntry;
    });
    if (!nextEntry) {
      return null;
    }

    this.writePendingWorktrees(entries);
    return nextEntry;
  }

  private syncPendingWorktreesSharedObject(): void {
    this.sharedObjects.set("pending_worktrees", this.readPendingWorktrees());
    if (this.sharedObjectSubscriptions.has("pending_worktrees")) {
      this.emitSharedObjectUpdate("pending_worktrees");
    }
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
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown } | null> {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/+/, "");
    switch (path) {
      case "apply-patch":
        try {
          return {
            status: 200,
            body: await this.sendGitWorkerRequest("apply-patch", body, signal),
          };
        } catch (error) {
          return {
            status: 500,
            body: {
              error: normalizeError(error).message,
            },
          };
        }
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
      case "generate-thread-title":
        return {
          status: 200,
          body: this.generateThreadTitle(body),
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
            codexHome: this.codexHomePath,
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
      case "read-file":
        return await this.readCodexFile(body);
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
          body: await this.readRecommendedSkills(body),
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
          body: await this.readGhCliStatus(),
        };
      case "gh-pr-status":
        return {
          status: 200,
          body: await this.readGhPrStatus(body),
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

  private async readGhCliStatus(): Promise<GhCliStatus> {
    const cwd = this.cwd.length > 0 ? this.cwd : process.cwd();
    const installed = await isGhInstalled(cwd);
    if (!installed) {
      return {
        isInstalled: false,
        isAuthenticated: false,
      };
    }

    return {
      isInstalled: true,
      isAuthenticated: await isGhAuthenticated(cwd),
    };
  }

  private async readGhPrStatus(body: unknown): Promise<GhPrStatus> {
    const cliStatus = await this.readGhCliStatus();
    if (!cliStatus.isInstalled || !cliStatus.isAuthenticated) {
      return {
        status: "unavailable",
        hasOpenPr: false,
        isDraft: false,
        canMerge: false,
        ciStatus: null,
        url: null,
      };
    }

    const fallbackDirs = this.getGitOriginFallbackDirectories();
    const requestedDir = readGhTargetDirectory(body);
    const candidateDir = requestedDir ?? fallbackDirs[0] ?? this.cwd;
    if (!candidateDir) {
      return {
        status: "available",
        hasOpenPr: false,
        isDraft: false,
        canMerge: false,
        ciStatus: null,
        url: null,
      };
    }

    const repository = await resolveGitRepository(
      candidateDir,
      new Map<string, GitRepositoryInfo>(),
    );
    if (!repository) {
      return {
        status: "available",
        hasOpenPr: false,
        isDraft: false,
        canMerge: false,
        ciStatus: null,
        url: null,
      };
    }

    const prInfo = await readGhPrInfo(repository.root);
    if (!prInfo) {
      return {
        status: "available",
        hasOpenPr: false,
        isDraft: false,
        canMerge: false,
        ciStatus: null,
        url: null,
      };
    }

    const state = prInfo.state ? prInfo.state.toUpperCase() : "";
    const hasOpenPr = state === "OPEN";
    if (!hasOpenPr) {
      return {
        status: "available",
        hasOpenPr: false,
        isDraft: false,
        canMerge: false,
        ciStatus: null,
        url: null,
      };
    }

    const mergeable = prInfo.mergeable ? prInfo.mergeable.toUpperCase() : "";
    const isDraft = prInfo.isDraft;
    const canMerge = mergeable === "MERGEABLE" && !isDraft;
    return {
      status: "available",
      hasOpenPr: true,
      isDraft,
      canMerge,
      ciStatus: deriveGhCiStatus(prInfo.statusCheckRollup),
      url: prInfo.url,
    };
  }

  private async readWhamUsage(): Promise<WhamUsagePayload> {
    try {
      const result = await this.sendLocalRequestSafely("account/rateLimits/read");
      const payload = buildWhamUsagePayload(result);
      if (payload.rate_limit || payload.plan_type || payload.credits) {
        return payload;
      }
    } catch (error) {
      debugLog("status", "failed to read local account rate limits", {
        error: normalizeError(error).message,
      });
    }

    return buildWhamUsagePayloadFromResponse(await readWhamUsageFromCodexHome(this.codexHomePath));
  }

  private async readManagedCodexAuth(): Promise<ManagedCodexAuth | null> {
    const authPath = join(this.codexHomePath, "auth.json");

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

  private async readRecommendedSkills(_body: unknown): Promise<RecommendedSkillsResponse> {
    const repoRoot = resolveRecommendedSkillsRepoRoot();

    try {
      return {
        repoRoot,
        skills: await listRecommendedSkills(repoRoot),
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return {
          repoRoot,
          skills: [],
        };
      }

      const normalizedError = normalizeError(error);
      debugLog("app-server", "failed to load recommended skills", {
        error: normalizedError.message,
        repoRoot,
      });
      return {
        repoRoot,
        skills: [],
        error: "Unable to load recommended skills.",
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

  private async readCodexFile(body: unknown): Promise<RelativeFetchResponse> {
    const path = readCodexFilePath(body);
    if (!path) {
      return {
        status: 400,
        body: {
          error: "File path is required.",
        },
      };
    }

    let resolvedPath: string;
    try {
      resolvedPath = normalizeCodexReadFilePath(path);
    } catch (error) {
      return {
        status: 400,
        body: {
          error: normalizeError(error).message,
        },
      };
    }

    try {
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) {
        return {
          status: 400,
          body: {
            error: "File path must point to a file.",
          },
        };
      }

      return {
        status: 200,
        body: {
          path: resolvedPath,
          contents: await readFile(resolvedPath, "utf8"),
        },
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return {
          status: 404,
          body: {
            error: "File not found.",
          },
        };
      }

      if (isPermissionDeniedError(error)) {
        return {
          status: 403,
          body: {
            error: "File is not readable.",
          },
        };
      }

      throw error;
    }
  }

  private readDeveloperInstructions(body: unknown): string | null {
    if (!isJsonRecord(body)) {
      return null;
    }

    const params = isJsonRecord(body.params) ? body.params : body;
    return typeof params.baseInstructions === "string" ? params.baseInstructions : null;
  }

  private generateThreadTitle(body: unknown): { title: string } {
    if (!isJsonRecord(body)) {
      return {
        title: "",
      };
    }

    const params = isJsonRecord(body.params) ? body.params : body;
    const prompt = typeof params.prompt === "string" ? params.prompt : "";

    return {
      title: summarizePromptAsThreadTitle(prompt),
    };
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
    const resumePath = readExistingAbsoluteThreadPath(params.path);
    if (resumePath) {
      sanitized.path = resumePath;
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

  private async addWorkspaceRootOption(body: unknown): Promise<{
    success: boolean;
    root: string;
    error?: string;
  }> {
    const root = isJsonRecord(body) && typeof body.root === "string" ? body.root.trim() : null;
    const label = isJsonRecord(body) && typeof body.label === "string" ? body.label : null;
    const setActive = !isJsonRecord(body) || body.setActive !== false;

    if (!root) {
      this.openWorkspaceRootPicker("manual");
      return {
        success: false,
        root: "",
      };
    }

    let normalizedRoot: string;
    try {
      normalizedRoot = this.normalizeWorkspaceRootPickerPath(root, false);
    } catch (error) {
      return {
        success: false,
        root,
        error: normalizeError(error).message,
      };
    }
    const validationError = await this.getWorkspaceRootValidationError(normalizedRoot);
    if (validationError) {
      return {
        success: false,
        root: normalizedRoot,
        error: validationError,
      };
    }

    this.ensureWorkspaceRoot(normalizedRoot, {
      label,
      setActive,
    });
    await this.persistWorkspaceRootRegistry();
    this.emitWorkspaceRootsUpdated();
    return {
      success: true,
      root: normalizedRoot,
    };
  }

  private async getWorkspaceRootValidationError(root: string): Promise<string | null> {
    try {
      const stats = await stat(root);
      if (!stats.isDirectory()) {
        return "Project path must point to a directory on the host filesystem.";
      }
      return null;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code === "ENOENT") {
        return "Project path does not exist on the host filesystem.";
      }
      return `Failed to access project path on the host filesystem: ${normalizeError(error).message}`;
    }
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
        ? normalizeWorkspaceRootHostPath(expandWorkspaceRootPickerHome(trimmedPath))
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
    this.pendingMcpRequestMethods.clear();
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

function compareWorkspaceRootBrowserEntries(
  left: { name: string },
  right: { name: string },
): number {
  const leftHidden = left.name.startsWith(".");
  const rightHidden = right.name.startsWith(".");
  if (leftHidden !== rightHidden) {
    return leftHidden ? 1 : -1;
  }

  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

async function readWhamUsageFromCodexHome(codexHomePath: string): Promise<WhamUsageResponse> {
  debugLog("status", "reading /wham/usage from codex home", {
    codexHomePath,
  });
  const authMetadata = await readCodexAuthMetadata(codexHomePath);
  const sessionSnapshot = await readLatestCodexRateLimitSnapshot(codexHomePath);
  const baseUsage = buildWhamUsageResponse(sessionSnapshot, authMetadata);

  debugLog("status", "resolved /wham/usage inputs", {
    authPlanType: authMetadata?.planType ?? null,
    snapshot: summarizeRateLimitSnapshot(sessionSnapshot),
    response: summarizeWhamUsageResponse(baseUsage),
  });

  if (baseUsage.rate_limit || baseUsage.plan_type || baseUsage.credits) {
    return baseUsage;
  }

  return {
    credits: null,
    plan_type: null,
    rate_limit: null,
    additional_rate_limits: [],
  };
}

async function readCodexAuthMetadata(
  codexHomePath: string,
): Promise<{ planType: string | null } | null> {
  try {
    const authJson = JSON.parse(
      await readFile(join(codexHomePath, "auth.json"), "utf8"),
    ) as unknown;
    if (!isJsonRecord(authJson) || !isJsonRecord(authJson.tokens)) {
      return null;
    }

    const accessToken =
      typeof authJson.tokens.access_token === "string" ? authJson.tokens.access_token : null;
    if (!accessToken) {
      return null;
    }

    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
      return null;
    }

    const authPayload = isJsonRecord(payload["https://api.openai.com/auth"])
      ? payload["https://api.openai.com/auth"]
      : null;

    return {
      planType:
        authPayload && typeof authPayload.chatgpt_plan_type === "string"
          ? authPayload.chatgpt_plan_type
          : null,
    };
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): JsonRecord | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isJsonRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function readLatestCodexRateLimitSnapshot(codexHomePath: string): Promise<JsonRecord | null> {
  const sessionFiles = await listRecentCodexSessionFiles(join(codexHomePath, "sessions"), 8);
  debugLog("status", "scanning codex session files for rate limits", {
    sessionFileCount: sessionFiles.length,
    sessionFiles,
  });
  for (const sessionFile of sessionFiles) {
    const snapshot = await readLatestRateLimitSnapshotFromSessionFile(sessionFile);
    if (snapshot) {
      debugLog("status", "selected codex rate-limit snapshot", {
        sessionFile,
        snapshot: summarizeRateLimitSnapshot(snapshot),
      });
      return snapshot;
    }
  }

  debugLog("status", "no codex rate-limit snapshot found");
  return null;
}

async function listRecentCodexSessionFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (files.length >= limit) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    const sorted = [...entries].sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of sorted) {
      if (files.length >= limit) {
        return;
      }

      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  await visit(root);
  return files;
}

async function readLatestRateLimitSnapshotFromSessionFile(
  sessionFile: string,
): Promise<JsonRecord | null> {
  let rawSession = "";
  try {
    rawSession = await readFile(sessionFile, "utf8");
  } catch {
    return null;
  }

  const lines = rawSession.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as unknown;
      const snapshot = extractRateLimitSnapshot(entry);
      if (snapshot) {
        return snapshot;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function extractRateLimitSnapshot(entry: unknown): JsonRecord | null {
  if (!isJsonRecord(entry) || entry.type !== "event_msg" || !isJsonRecord(entry.payload)) {
    return null;
  }

  const payload = entry.payload;
  if (payload.type !== "token_count" || !isJsonRecord(payload.rate_limits)) {
    return null;
  }

  return payload.rate_limits;
}

function buildWhamUsageResponse(
  snapshot: JsonRecord | null,
  authMetadata: { planType: string | null } | null,
): WhamUsageResponse {
  const credits = mapWhamUsageCredits(snapshot?.credits);
  const planType =
    typeof snapshot?.plan_type === "string" ? snapshot.plan_type : (authMetadata?.planType ?? null);
  const primaryWindow = mapWhamUsageWindow(snapshot?.primary);
  const secondaryWindow = mapWhamUsageWindow(snapshot?.secondary);
  const topLevelRateLimit =
    primaryWindow || secondaryWindow
      ? {
          allowed: coerceAllowed(snapshot, [primaryWindow, secondaryWindow]),
          limit_reached: coerceLimitReached(snapshot, [primaryWindow, secondaryWindow]),
          rate_limit_name:
            typeof snapshot?.limit_name === "string"
              ? snapshot.limit_name
              : typeof snapshot?.rate_limit_name === "string"
                ? snapshot.rate_limit_name
                : null,
          primary_window: primaryWindow,
          secondary_window: secondaryWindow,
        }
      : null;

  const additionalRateLimits = Array.isArray(snapshot?.additional_rate_limits)
    ? snapshot.additional_rate_limits
        .map(mapWhamAdditionalRateLimit)
        .filter((value): value is WhamUsageAdditionalRateLimit => value !== null)
    : [];

  return {
    credits,
    plan_type: planType,
    rate_limit: topLevelRateLimit,
    additional_rate_limits: additionalRateLimits,
  };
}

function buildWhamUsagePayloadFromResponse(response: WhamUsageResponse): WhamUsagePayload {
  return {
    credits: response.credits
      ? {
          has_credits: response.credits.has_credits,
          unlimited: response.credits.unlimited,
          balance:
            typeof response.credits.balance === "number" ? String(response.credits.balance) : null,
        }
      : null,
    plan_type: response.plan_type,
    rate_limit_name: response.rate_limit?.rate_limit_name ?? null,
    rate_limit: response.rate_limit
      ? {
          primary_window: response.rate_limit.primary_window,
          secondary_window: response.rate_limit.secondary_window,
          limit_reached: response.rate_limit.limit_reached,
          allowed: response.rate_limit.allowed,
        }
      : null,
    additional_rate_limits: response.additional_rate_limits.map((limit) => ({
      limit_name: limit.limit_name,
      rate_limit: {
        primary_window: limit.rate_limit.primary_window,
        secondary_window: limit.rate_limit.secondary_window,
        limit_reached: limit.rate_limit.limit_reached,
        allowed: limit.rate_limit.allowed,
      },
    })),
  };
}

function mapWhamAdditionalRateLimit(value: unknown): WhamUsageAdditionalRateLimit | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  const limitName = typeof value.limit_name === "string" ? value.limit_name.trim() : "";
  if (!limitName) {
    return null;
  }

  const rateLimitRecord = isJsonRecord(value.rate_limit) ? value.rate_limit : value;
  const primaryWindow = mapWhamUsageWindow(
    rateLimitRecord.primary ?? rateLimitRecord.primary_window,
  );
  const secondaryWindow = mapWhamUsageWindow(
    rateLimitRecord.secondary ?? rateLimitRecord.secondary_window,
  );

  if (!primaryWindow && !secondaryWindow) {
    return null;
  }

  return {
    limit_name: limitName,
    rate_limit: {
      allowed: coerceAllowed(rateLimitRecord, [primaryWindow, secondaryWindow]),
      limit_reached: coerceLimitReached(rateLimitRecord, [primaryWindow, secondaryWindow]),
      rate_limit_name: limitName,
      primary_window: primaryWindow,
      secondary_window: secondaryWindow,
    },
  };
}

function mapWhamUsageCredits(value: unknown): WhamUsageCredits | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  return {
    has_credits: value.has_credits === true,
    unlimited: value.unlimited === true,
    balance: typeof value.balance === "number" ? value.balance : null,
  };
}

function mapWhamUsageWindow(value: unknown): WhamUsageWindow | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  const usedPercent =
    typeof value.used_percent === "number"
      ? value.used_percent
      : typeof value.usedPercent === "number"
        ? value.usedPercent
        : null;
  if (usedPercent === null) {
    return null;
  }

  let limitWindowSeconds: number | null = null;
  if (typeof value.limit_window_seconds === "number") {
    limitWindowSeconds = value.limit_window_seconds;
  } else if (typeof value.window_minutes === "number") {
    limitWindowSeconds = value.window_minutes * 60;
  }

  const resetAt =
    typeof value.reset_at === "number"
      ? value.reset_at
      : typeof value.resets_at === "number"
        ? value.resets_at
        : null;

  return {
    used_percent: usedPercent,
    limit_window_seconds: limitWindowSeconds,
    reset_at: resetAt,
  };
}

function coerceAllowed(
  snapshot: JsonRecord | null,
  windows: Array<WhamUsageWindow | null>,
): boolean {
  if (snapshot && typeof snapshot.allowed === "boolean") {
    return snapshot.allowed;
  }

  return !coerceLimitReached(snapshot, windows);
}

function coerceLimitReached(
  snapshot: JsonRecord | null,
  windows: Array<WhamUsageWindow | null>,
): boolean {
  if (snapshot && typeof snapshot.limit_reached === "boolean") {
    return snapshot.limit_reached;
  }

  const maxUsedPercent = windows.reduce(
    (highest, window) => (window ? Math.max(highest, window.used_percent) : highest),
    0,
  );
  return maxUsedPercent >= 100;
}

function summarizeRateLimitSnapshot(snapshot: JsonRecord | null): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }

  return {
    limitId: typeof snapshot.limit_id === "string" ? snapshot.limit_id : null,
    limitName:
      typeof snapshot.limit_name === "string"
        ? snapshot.limit_name
        : typeof snapshot.rate_limit_name === "string"
          ? snapshot.rate_limit_name
          : null,
    planType: typeof snapshot.plan_type === "string" ? snapshot.plan_type : null,
    primary: summarizeSnapshotWindow(snapshot.primary),
    secondary: summarizeSnapshotWindow(snapshot.secondary),
    hasCredits: isJsonRecord(snapshot.credits) ? snapshot.credits.has_credits === true : null,
  };
}

function summarizeSnapshotWindow(windowValue: unknown): Record<string, unknown> | null {
  if (!isJsonRecord(windowValue)) {
    return null;
  }

  return {
    usedPercent:
      typeof windowValue.used_percent === "number"
        ? windowValue.used_percent
        : typeof windowValue.usedPercent === "number"
          ? windowValue.usedPercent
          : null,
    windowMinutes:
      typeof windowValue.window_minutes === "number"
        ? windowValue.window_minutes
        : typeof windowValue.limit_window_seconds === "number"
          ? windowValue.limit_window_seconds / 60
          : null,
    resetAt:
      typeof windowValue.resets_at === "number"
        ? windowValue.resets_at
        : typeof windowValue.reset_at === "number"
          ? windowValue.reset_at
          : null,
  };
}

function summarizeWhamUsageResponse(body: unknown): Record<string, unknown> | null {
  if (!isJsonRecord(body)) {
    return null;
  }

  return {
    planType: typeof body.plan_type === "string" ? body.plan_type : null,
    hasCredits: isJsonRecord(body.credits) ? body.credits.has_credits === true : null,
    rateLimit: isJsonRecord(body.rate_limit)
      ? {
          allowed: body.rate_limit.allowed === true,
          limitReached: body.rate_limit.limit_reached === true,
          rateLimitName:
            typeof body.rate_limit.rate_limit_name === "string"
              ? body.rate_limit.rate_limit_name
              : null,
          primary: summarizeSnapshotWindow(body.rate_limit.primary_window),
          secondary: summarizeSnapshotWindow(body.rate_limit.secondary_window),
        }
      : null,
    additionalRateLimitCount: Array.isArray(body.additional_rate_limits)
      ? body.additional_rate_limits.length
      : 0,
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

async function isGhInstalled(cwd: string): Promise<boolean> {
  const result = await execGhCommand(cwd, ["--version"]);
  return result.ok;
}

async function isGhAuthenticated(cwd: string): Promise<boolean> {
  const result = await execGhCommand(cwd, ["auth", "status", "--hostname", "github.com"]);
  return result.ok;
}

async function readGhPrInfo(root: string): Promise<GhPrInfo | null> {
  const fields = "isDraft,mergeable,state,url,statusCheckRollup";
  const result = await execGhCommand(root, ["pr", "view", "--json", fields]);
  if (!result.ok) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (!isJsonRecord(parsed)) {
      return null;
    }

    return {
      state: typeof parsed.state === "string" ? parsed.state : null,
      isDraft: parsed.isDraft === true,
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : null,
      url: typeof parsed.url === "string" ? parsed.url : null,
      statusCheckRollup: parsed.statusCheckRollup,
    };
  } catch (error) {
    debugLog("app-server", "failed to parse gh pr view output", {
      error: normalizeError(error).message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return null;
  }
}

function readGhTargetDirectory(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  if (!isJsonRecord(params)) {
    return null;
  }

  if (typeof params.path === "string") {
    return params.path;
  }
  if (typeof params.dir === "string") {
    return params.dir;
  }
  if (typeof params.cwd === "string") {
    return params.cwd;
  }
  if (typeof params.root === "string") {
    return params.root;
  }
  if (typeof params.workspaceRoot === "string") {
    return params.workspaceRoot;
  }

  return null;
}

function deriveGhCiStatus(statusCheckRollup: unknown): string | null {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return null;
  }

  let hasFailure = false;
  let hasPending = false;
  let hasSuccess = false;
  for (const entry of statusCheckRollup) {
    if (!isJsonRecord(entry)) {
      continue;
    }

    const status = typeof entry.status === "string" ? entry.status.toUpperCase() : "";
    const conclusion = typeof entry.conclusion === "string" ? entry.conclusion.toUpperCase() : "";

    if (status && status !== "COMPLETED") {
      hasPending = true;
      continue;
    }

    if (!conclusion) {
      hasPending = true;
      continue;
    }

    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
      hasSuccess = true;
      continue;
    }

    if (
      ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE"].includes(
        conclusion,
      )
    ) {
      hasFailure = true;
      continue;
    }

    hasPending = true;
  }

  if (hasFailure) {
    return "failure";
  }
  if (hasPending) {
    return "pending";
  }
  if (hasSuccess) {
    return "success";
  }
  return null;
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

async function execGhCommand(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GH_PAGER: "cat",
          GIT_PAGER: "cat",
        },
      },
      (error, stdout, stderr) => {
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();
        if (error) {
          resolve({
            ok: false,
            stdout: trimmedStdout,
            stderr: trimmedStderr || normalizeError(error).message,
          });
          return;
        }

        resolve({
          ok: true,
          stdout: trimmedStdout,
          stderr: trimmedStderr,
        });
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

function readExistingAbsoluteThreadPath(value: unknown): string | null {
  if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value)) {
    return null;
  }

  return value;
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

function normalizeWorkspaceRootHostPath(path: string): string {
  const normalizedWslUncPath = convertWorkspaceRootWslUncPathToLinux(path);
  if (normalizedWslUncPath) {
    return normalizedWslUncPath;
  }

  return convertWorkspaceRootWindowsPathToWsl(path);
}

function convertWorkspaceRootWindowsPathToWsl(path: string): string {
  if (!isRunningInWsl()) {
    return path;
  }

  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path;
  }

  const driveLetter = match[1].toLowerCase();
  const relativePath = match[2].replaceAll("\\", "/");
  return `/mnt/${driveLetter}/${relativePath}`;
}

function convertWorkspaceRootWslUncPathToLinux(path: string): string | null {
  if (!isRunningInWsl()) {
    return null;
  }

  const lowerCasePath = path.toLowerCase();
  let prefixLength = 0;
  if (lowerCasePath.startsWith("\\\\wsl$\\")) {
    prefixLength = "\\\\wsl$\\".length;
  } else if (lowerCasePath.startsWith("\\\\wsl.localhost\\")) {
    prefixLength = "\\\\wsl.localhost\\".length;
  } else {
    return null;
  }

  const segments = path
    .slice(prefixLength)
    .split("\\")
    .filter((segment) => segment.length > 0);
  const distroName = segments.shift();
  const currentDistroName = process.env.WSL_DISTRO_NAME?.trim().toLowerCase();
  if (!distroName) {
    return null;
  }
  if (currentDistroName && distroName.toLowerCase() !== currentDistroName) {
    return null;
  }

  return `/${segments.join("/")}`;
}

function isRunningInWsl(): boolean {
  return (
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
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

function resolveRecommendedSkillsRepoRoot(): string {
  return join(deriveCodexHomePath(), "vendor_imports", "skills");
}

async function listRecommendedSkills(repoRoot: string): Promise<RecommendedSkill[]> {
  const definitions = await listRecommendedSkillDefinitions(repoRoot);
  const skills = await Promise.all(
    definitions.map(async ({ repoPath, skillPath }) => {
      const metadata = await readRecommendedSkillFrontmatter(skillPath);
      const name = metadata.name ?? basename(repoPath);
      const description = metadata.description ?? metadata.shortDescription ?? name;
      return {
        id: name,
        name,
        description,
        shortDescription: metadata.shortDescription,
        repoPath,
        path: repoPath,
        ...(metadata.iconSmall ? { iconSmall: metadata.iconSmall } : {}),
        ...(metadata.iconLarge ? { iconLarge: metadata.iconLarge } : {}),
      } satisfies RecommendedSkill;
    }),
  );

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function listRecommendedSkillDefinitions(
  repoRoot: string,
): Promise<Array<{ repoPath: string; skillPath: string }>> {
  for (const candidateRoot of [
    join(repoRoot, "skills", ".curated"),
    join(repoRoot, ".curated"),
    repoRoot,
  ]) {
    const definitions = await collectRecommendedSkillDefinitions(repoRoot, candidateRoot);
    if (definitions.length > 0 || candidateRoot === repoRoot) {
      return definitions;
    }
  }

  return [];
}

async function collectRecommendedSkillDefinitions(
  repoRoot: string,
  directory: string,
): Promise<Array<{ repoPath: string; skillPath: string }>> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    const repoPath = normalizeRecommendedSkillRepoPath(relative(repoRoot, directory));
    return [
      {
        repoPath,
        skillPath: join(directory, "SKILL.md"),
      },
    ];
  }

  const discovered: Array<{ repoPath: string; skillPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    discovered.push(
      ...(await collectRecommendedSkillDefinitions(repoRoot, join(directory, entry.name))),
    );
  }
  return discovered;
}

function normalizeRecommendedSkillRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function readRecommendedSkillFrontmatter(skillPath: string): Promise<{
  name: string | null;
  description: string | null;
  shortDescription: string | null;
  iconSmall: string | null;
  iconLarge: string | null;
}> {
  const contents = await readFile(skillPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!match) {
    return {
      name: null,
      description: null,
      shortDescription: null,
      iconSmall: null,
      iconLarge: null,
    };
  }

  let activeSection: string | null = null;
  let name: string | null = null;
  let description: string | null = null;
  let shortDescription: string | null = null;
  let iconSmall: string | null = null;
  let iconLarge: string | null = null;

  for (const line of match[1].split(/\r?\n/)) {
    const topLevelMatch = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (topLevelMatch) {
      const key = topLevelMatch[1];
      const value = normalizeFrontmatterScalar(topLevelMatch[2]);
      activeSection = key === "metadata" && value === null ? "metadata" : null;

      switch (normalizeFrontmatterKey(key)) {
        case "name":
          name = value;
          break;
        case "description":
          description = value;
          break;
        case "shortdescription":
          shortDescription = value;
          break;
        case "iconsmall":
          iconSmall = value;
          break;
        case "iconlarge":
          iconLarge = value;
          break;
        default:
          break;
      }
      continue;
    }

    if (activeSection !== "metadata") {
      continue;
    }

    const nestedMatch = /^\s+([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!nestedMatch) {
      continue;
    }

    const key = normalizeFrontmatterKey(nestedMatch[1]);
    const value = normalizeFrontmatterScalar(nestedMatch[2]);
    if (key === "shortdescription") {
      shortDescription = value;
    }
  }

  return {
    name,
    description,
    shortDescription,
    iconSmall,
    iconLarge,
  };
}

function normalizeFrontmatterKey(key: string): string {
  return key.replaceAll(/[\s_-]+/g, "").toLowerCase();
}

function normalizeFrontmatterScalar(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (
    (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) ||
    (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))
  ) {
    return trimmed.slice(1, -1).trim() || null;
  }

  return trimmed;
}

async function renderableImageUrlFromPath(
  value: string,
  basePaths: Array<string | null>,
): Promise<string | null> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (isWebRenderableImageUrl(trimmed)) {
    return trimmed;
  }

  const filePath = await resolveLocalImageAssetPath(trimmed, basePaths);
  if (!filePath) {
    return null;
  }

  const mimeType = getImageMimeType(filePath);
  if (!mimeType) {
    return null;
  }

  const contents = await readFile(filePath);
  return `data:${mimeType};base64,${contents.toString("base64")}`;
}

async function resolveLocalImageAssetPath(
  assetPath: string,
  basePaths: Array<string | null>,
): Promise<string | null> {
  if (isAbsolute(assetPath)) {
    return (await isRegularFile(assetPath)) ? assetPath : null;
  }

  for (const basePath of basePaths) {
    const resolvedBasePath = await resolveAssetBasePath(basePath);
    if (!resolvedBasePath) {
      continue;
    }

    const candidate = resolve(resolvedBasePath, assetPath);
    if (await isRegularFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function resolveAssetBasePath(basePath: string | null): Promise<string | null> {
  if (!basePath) {
    return null;
  }

  try {
    const fileStats = await stat(basePath);
    return fileStats.isFile() ? dirname(basePath) : basePath;
  } catch {
    return looksLikeFilePath(basePath) ? dirname(basePath) : basePath;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isWebRenderableImageUrl(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://");
}

function looksLikeFilePath(path: string): boolean {
  return basename(path).includes(".");
}

function getImageMimeType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function readCodexAgentsMarkdownContents(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  if (!isJsonRecord(params) || typeof params.contents !== "string") {
    return null;
  }

  return params.contents;
}

function readCodexFilePath(body: unknown): string | null {
  const params = readCodexFetchParams(body);
  return isJsonRecord(params) && typeof params.path === "string" ? params.path : null;
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

function isPermissionDeniedError(error: unknown): boolean {
  return isJsonRecord(error) && error.code === "EACCES";
}

function normalizeCodexReadFilePath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) {
    throw new Error("File path is required.");
  }

  const expandedPath = expandWorkspaceRootPickerHome(trimmedPath);
  if (!isAbsolute(expandedPath)) {
    throw new Error("File path must be absolute.");
  }

  return resolve(expandedPath);
}

function readFetchErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }

  if (isJsonRecord(body)) {
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error;
    }

    if (typeof body.message === "string" && body.message.trim().length > 0) {
      return body.message;
    }
  }

  return fallback;
}

function parsePendingWorktreeEntryRequest(
  value: unknown,
  hostId: string,
): PendingWorktreeEntry | null {
  if (!isJsonRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const label = typeof value.label === "string" ? value.label : "";
  const sourceWorkspaceRoot =
    typeof value.sourceWorkspaceRoot === "string" ? value.sourceWorkspaceRoot : "";
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  const localEnvironmentConfigPath =
    typeof value.localEnvironmentConfigPath === "string" ? value.localEnvironmentConfigPath : null;
  const sourceConversationId =
    typeof value.sourceConversationId === "string" ? value.sourceConversationId : null;
  const sourceCollaborationMode =
    typeof value.sourceCollaborationMode === "string" ? value.sourceCollaborationMode : null;

  if (!id || !sourceWorkspaceRoot || !prompt) {
    return null;
  }
  if (!isJsonRecord(value.startingState) || typeof value.startingState.type !== "string") {
    return null;
  }

  const launchMode = parsePendingWorktreeLaunchMode(value.launchMode);
  if (!launchMode) {
    return null;
  }

  return {
    id,
    hostId,
    createdAt: Date.now(),
    phase: "queued",
    labelEdited: false,
    outputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: null,
    worktreeGitRoot: null,
    needsAttention: false,
    isPinned: false,
    label,
    sourceWorkspaceRoot,
    startingState: value.startingState,
    localEnvironmentConfigPath,
    prompt,
    launchMode,
    startConversationParamsInput: value.startConversationParamsInput ?? null,
    sourceConversationId,
    sourceCollaborationMode,
  };
}

function parsePendingWorktreeLaunchMode(value: unknown): PendingWorktreeLaunchMode | null {
  switch (value) {
    case "create-stable-worktree":
    case "fork-conversation":
    case "start-conversation":
      return value;
    default:
      return null;
  }
}

function parsePendingWorktreeMetadataUpdate(value: unknown):
  | {
      type: "isPinned";
      isPinned: boolean;
    }
  | {
      type: "label";
      label: string;
    }
  | {
      type: "labelEdited";
      labelEdited: boolean;
    }
  | {
      type: "needsAttention";
      needsAttention: boolean;
    }
  | null {
  if (!isJsonRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "isPinned":
      return typeof value.isPinned === "boolean"
        ? {
            type: "isPinned",
            isPinned: value.isPinned,
          }
        : null;
    case "label":
      return typeof value.label === "string"
        ? {
            type: "label",
            label: value.label,
          }
        : null;
    case "labelEdited":
      return typeof value.labelEdited === "boolean"
        ? {
            type: "labelEdited",
            labelEdited: value.labelEdited,
          }
        : null;
    case "needsAttention":
      return typeof value.needsAttention === "boolean"
        ? {
            type: "needsAttention",
            needsAttention: value.needsAttention,
          }
        : null;
    default:
      return null;
  }
}

function isPendingWorktreeEntry(value: unknown): value is PendingWorktreeEntry {
  return (
    isJsonRecord(value) &&
    typeof value.id === "string" &&
    typeof value.hostId === "string" &&
    typeof value.label === "string" &&
    typeof value.sourceWorkspaceRoot === "string" &&
    typeof value.outputText === "string" &&
    typeof value.prompt === "string" &&
    (value.errorMessage === null || typeof value.errorMessage === "string") &&
    (value.worktreeWorkspaceRoot === null || typeof value.worktreeWorkspaceRoot === "string") &&
    (value.worktreeGitRoot === null || typeof value.worktreeGitRoot === "string") &&
    typeof value.labelEdited === "boolean" &&
    typeof value.needsAttention === "boolean" &&
    typeof value.isPinned === "boolean" &&
    isJsonRecord(value.startingState) &&
    typeof value.startingState.type === "string" &&
    (value.localEnvironmentConfigPath === null ||
      typeof value.localEnvironmentConfigPath === "string") &&
    (value.sourceConversationId === null || typeof value.sourceConversationId === "string") &&
    (value.sourceCollaborationMode === null || typeof value.sourceCollaborationMode === "string") &&
    (value.phase === "queued" ||
      value.phase === "creating" ||
      value.phase === "worktree-ready" ||
      value.phase === "failed") &&
    (value.launchMode === "create-stable-worktree" ||
      value.launchMode === "fork-conversation" ||
      value.launchMode === "start-conversation")
  );
}

function readPendingWorktreeWorkerEvent(
  message: JsonRecord,
  streamId: string,
):
  | {
      type: "path";
      worktreeGitRoot: string;
    }
  | {
      type: "stream";
      text: string;
    }
  | null {
  if (message.type !== "worker-event" || !isJsonRecord(message.event)) {
    return null;
  }

  if (
    message.event.type === "create-worktree-path" &&
    message.event.streamId === streamId &&
    typeof message.event.worktreeGitRoot === "string"
  ) {
    return {
      type: "path",
      worktreeGitRoot: message.event.worktreeGitRoot,
    };
  }

  if (message.event.type !== "create-worktree-stream" || message.event.streamId !== streamId) {
    return null;
  }

  return {
    type: "stream",
    text: readPendingWorktreeWorkerText(message.event.data),
  };
}

function readPendingWorktreeWorkerText(data: unknown): string {
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("utf8");
  }

  if (Array.isArray(data) && data.every((value) => typeof value === "number")) {
    return Buffer.from(data).toString("utf8");
  }

  if (!isJsonRecord(data)) {
    return "";
  }

  const bytes = Object.entries(data)
    .filter(
      (entry): entry is [string, number] => /^\d+$/.test(entry[0]) && typeof entry[1] === "number",
    )
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([, value]) => value);
  return bytes.length > 0 ? Buffer.from(bytes).toString("utf8") : "";
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

function summarizePromptAsThreadTitle(prompt: string): string {
  const normalized = normalizeThreadTitleText(prompt);
  if (normalized.length === 0) {
    return "";
  }

  const strippedPrefix = normalized.replace(
    /^(?:please\s+)?(?:(?:spin|start|launch|create)\s+up?\s+|use\s+|have\s+)?(?:an?\s+)?subagent\s+to\s+/i,
    "",
  );
  const candidate = strippedPrefix.length > 0 ? strippedPrefix : normalized;
  return truncateThreadTitle(candidate, 60);
}

function normalizeThreadTitleText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateThreadTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
