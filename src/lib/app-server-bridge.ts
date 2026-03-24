import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  deriveCodexDesktopGlobalStatePath,
  loadCodexDesktopProjects,
} from "./codex-desktop-projects.js";
import {
  DefaultCodexDesktopGitWorkerBridge,
  type CodexDesktopGitWorkerBridge,
} from "./codex-desktop-git-worker.js";
import { debugLog } from "./debug.js";
import type { HostBridge, JsonRecord } from "./protocol.js";
import { deriveCodexCliBinaryPath } from "./startup-errors.js";
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
  appServerPath?: string;
  hostId?: string;
  codexDesktopGlobalStatePath?: string;
  persistedAtomRegistryPath?: string;
  workspaceRootRegistryPath?: string;
  gitWorkerBridge?: CodexDesktopGitWorkerBridge;
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

interface AppServerMcpRequestEnvelope {
  type: "mcp-request";
  request?: JsonRpcRequest;
}

interface AppServerMcpResponseEnvelope {
  type: "mcp-response";
  response?: JsonRpcResponse;
  message?: JsonRpcResponse;
}

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
  private readonly codexDesktopGlobalStatePath: string;
  private readonly persistedAtomRegistryPath: string;
  private readonly workspaceRootRegistryPath: string;
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
    this.codexDesktopGlobalStatePath =
      options.codexDesktopGlobalStatePath ?? deriveCodexDesktopGlobalStatePath();
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
    this.child = spawn(
      deriveCodexCliBinaryPath(options.appPath, options.appServerPath),
      ["app-server", "--listen", "stdio://"],
      {
        stdio: "pipe",
      },
    );

    this.bindProcess();
    this.bindGitWorker();
  }

  static async connect(options: AppServerBridgeOptions): Promise<AppServerBridge> {
    const bridge = new AppServerBridge(options);
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
        this.openDesktopImportDialog("manual");
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
        case "desktop-workspace-import/list":
          return buildIpcSuccessResponse(
            requestId,
            await this.listDesktopWorkspaceImportCandidates(),
          );
        case "desktop-workspace-import/apply":
          return buildIpcSuccessResponse(
            requestId,
            await this.applyDesktopWorkspaceImports(payload.params),
          );
        case "desktop-workspace-import/dismiss":
          return buildIpcSuccessResponse(
            requestId,
            await this.dismissDesktopWorkspaceImportPrompt(),
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

  private async listDesktopWorkspaceImportCandidates(): Promise<{
    found: boolean;
    path: string;
    promptSeen: boolean;
    shouldPrompt: boolean;
    projects: Array<{
      root: string;
      label: string;
      activeInCodex: boolean;
      alreadyImported: boolean;
      available: boolean;
    }>;
  }> {
    const loaded = await loadCodexDesktopProjects(this.codexDesktopGlobalStatePath);
    const projects = loaded.projects.map((project) => ({
      root: project.root,
      label: project.label,
      activeInCodex: project.active,
      alreadyImported: this.workspaceRoots.has(project.root),
      available: project.available,
    }));
    const shouldPrompt =
      !this.desktopImportPromptSeen &&
      projects.some((project) => project.available && !project.alreadyImported);

    return {
      found: loaded.found,
      path: loaded.path,
      promptSeen: this.desktopImportPromptSeen,
      shouldPrompt,
      projects,
    };
  }

  private async applyDesktopWorkspaceImports(params: unknown): Promise<{
    importedRoots: string[];
    skippedRoots: string[];
    promptSeen: boolean;
  }> {
    const requestedRoots =
      isJsonRecord(params) && Array.isArray(params.roots) ? uniqueStrings(params.roots) : [];
    const loaded = await loadCodexDesktopProjects(this.codexDesktopGlobalStatePath);
    const importableProjects = new Map(
      loaded.projects
        .filter((project) => project.available)
        .map((project) => [project.root, project] as const),
    );
    const importedRoots: string[] = [];
    const skippedRoots: string[] = [];

    for (const root of requestedRoots) {
      const project = importableProjects.get(root);
      if (!project || this.workspaceRoots.has(root)) {
        skippedRoots.push(root);
        continue;
      }

      this.ensureWorkspaceRoot(root, {
        label: project.label,
        setActive: false,
      });
      importedRoots.push(root);
    }

    this.desktopImportPromptSeen = true;
    await this.persistWorkspaceRootRegistry();

    if (importedRoots.length > 0) {
      this.emitWorkspaceRootsUpdated();
    } else {
      this.syncWorkspaceGlobalState();
    }

    return {
      importedRoots,
      skippedRoots,
      promptSeen: this.desktopImportPromptSeen,
    };
  }

  private async dismissDesktopWorkspaceImportPrompt(): Promise<{
    promptSeen: boolean;
  }> {
    this.desktopImportPromptSeen = true;
    await this.persistWorkspaceRootRegistry();
    return {
      promptSeen: this.desktopImportPromptSeen,
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

  private async handleThreadArchive(
    message: JsonRecord,
    method: "thread/archive" | "thread/unarchive",
  ): Promise<void> {
    const conversationId =
      typeof message.conversationId === "string" ? message.conversationId : null;
    if (!conversationId) {
      return;
    }

    try {
      await this.sendLocalRequest(method, {
        threadId: conversationId,
      });
    } catch (error) {
      this.emit("error", normalizeError(error));
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
        const handled = await this.handleCodexFetchRequest(message.url, body);
        if (handled) {
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
        const handled = await this.handleRelativeFetchRequest(message.url);
        if (handled) {
          this.emitFetchSuccess(message.requestId, handled.body, handled.status);
          return;
        }

        const response = await fetch(new URL(message.url, "https://chatgpt.com"), {
          method: typeof message.method === "string" ? message.method : "GET",
          headers: normalizeHeaders(message.headers),
          body: normalizeRequestBody(message.body),
          signal: controller.signal,
        });
        const bodyText = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        this.emit("bridge_message", {
          type: "fetch-response",
          requestId: message.requestId,
          responseType: "success",
          status: response.status,
          headers,
          bodyJsonString: JSON.stringify(parseResponseBody(bodyText)),
        });
        return;
      }

      const response = await fetch(message.url, {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: normalizeHeaders(message.headers),
        body: normalizeRequestBody(message.body),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      this.emit("bridge_message", {
        type: "fetch-response",
        requestId: message.requestId,
        responseType: "success",
        status: response.status,
        headers,
        bodyJsonString: JSON.stringify(parseResponseBody(bodyText)),
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
    await this.persistWorkspaceRootRegistry();
    this.emitBridgeMessage({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: true,
    });
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
          body: {
            environments: [],
          },
        };
      case "codex-home":
        return {
          status: 200,
          body: {
            codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
          },
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
          status: 200,
          body: {
            ideContext: null,
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
          body: {
            plan: null,
          },
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
    url: string,
  ): Promise<{ status: number; body: unknown } | null> {
    if (url === "/wham/accounts/check") {
      return {
        status: 200,
        body: {
          accounts: [],
          account_ordering: [],
        },
      };
    }

    if (url === "/wham/environments") {
      return {
        status: 200,
        body: [],
      };
    }

    if (url === "/wham/usage") {
      return {
        status: 200,
        body: {
          credits: null,
          plan_type: null,
          rate_limit: null,
        },
      };
    }

    if (url.startsWith("/wham/tasks/list")) {
      return {
        status: 200,
        body: {
          items: [],
          tasks: [],
          nextCursor: null,
        },
      };
    }

    return null;
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
      this.openDesktopImportDialog("manual");
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

  private openDesktopImportDialog(mode: "first-run" | "manual"): void {
    this.emitBridgeMessage({
      type: "pocodex-open-desktop-import-dialog",
      mode,
    });
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

  private emitFetchSuccess(requestId: string, body: unknown, status = 200): void {
    this.emit("bridge_message", {
      type: "fetch-response",
      requestId,
      responseType: "success",
      status,
      headers: {
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

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
