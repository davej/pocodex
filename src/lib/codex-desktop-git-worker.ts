import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import { ensureCodexDesktopWorkerScript, type CodexDesktopWorkerScript } from "./codex-bundle.js";
import { debugLog } from "./debug.js";

interface WorkerResponseResultError {
  message: string;
}

interface WorkerResponseResult {
  type: "ok" | "error";
  error?: WorkerResponseResultError;
  value?: unknown;
}

interface WorkerResponseEnvelope {
  type: "worker-response";
  workerId: string;
  response: {
    id: string | number;
    method: string;
    result: WorkerResponseResult;
  };
}

interface WorkerMainRpcRequestEnvelope {
  type: "worker-main-rpc-request";
  workerId: string;
  requestId: string;
  method: string;
  params?: unknown;
}

interface WorktreeCleanupInputs {
  hostKey: string;
  threadIds: string[];
}

export interface CodexDesktopGitWorkerBridge {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(message: unknown): Promise<void>;
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
  close(): Promise<void>;
}

interface PendingWorkerRequest {
  id: string | number;
  method: string;
}

interface CodexDesktopGitWorkerBridgeOptions {
  appPath: string;
  resolveWorkerScript?: () => Promise<CodexDesktopWorkerScript>;
  WorkerClass?: typeof Worker;
  codexAppSessionId?: string;
}

export class DefaultCodexDesktopGitWorkerBridge
  extends EventEmitter
  implements CodexDesktopGitWorkerBridge
{
  private readonly appPath: string;
  private readonly resolveWorkerScript: () => Promise<CodexDesktopWorkerScript>;
  private readonly WorkerClass: typeof Worker;
  private readonly codexAppSessionId: string;
  private readonly pendingRequests = new Map<string, PendingWorkerRequest>();
  private worker: Worker | null = null;
  private workerStartPromise: Promise<Worker> | null = null;
  private subscriberCount = 0;
  private isClosing = false;

  constructor(options: CodexDesktopGitWorkerBridgeOptions) {
    super();
    this.appPath = options.appPath;
    this.resolveWorkerScript =
      options.resolveWorkerScript ?? (() => ensureCodexDesktopWorkerScript(this.appPath));
    this.WorkerClass = options.WorkerClass ?? Worker;
    this.codexAppSessionId = options.codexAppSessionId ?? randomUUID();
  }

  async send(message: unknown): Promise<void> {
    const request = parseGitWorkerRequest(message);
    if (request) {
      this.pendingRequests.set(String(request.id), request);
      console.error(`[git-worker] request: ${request.method}`);
    } else {
      const cancellation = parseGitWorkerCancel(message);
      if (cancellation) {
        this.pendingRequests.delete(String(cancellation.id));
      }
    }

    try {
      const worker = await this.ensureWorker();
      worker.postMessage(message);
    } catch (error) {
      const normalized = normalizeError(error);
      debugLog("git-worker", "failed to send message", {
        error: normalized.message,
      });
      const requestToReject = request ? this.pendingRequests.get(String(request.id)) : null;
      if (requestToReject) {
        this.pendingRequests.delete(String(requestToReject.id));
        this.emit("message", buildWorkerErrorResponse(requestToReject, normalized));
      }
      this.emit("error", normalized);
    }
  }

  async subscribe(): Promise<void> {
    this.subscriberCount += 1;
    try {
      await this.ensureWorker();
    } catch (error) {
      this.emit("error", normalizeError(error));
    }
  }

  async unsubscribe(): Promise<void> {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
  }

  async close(): Promise<void> {
    this.isClosing = true;
    const worker = this.worker;
    this.worker = null;
    this.workerStartPromise = null;
    this.pendingRequests.clear();
    if (!worker) {
      return;
    }
    await worker.terminate();
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) {
      return this.worker;
    }
    if (this.workerStartPromise) {
      return this.workerStartPromise;
    }

    this.workerStartPromise = this.startWorker();
    try {
      const worker = await this.workerStartPromise;
      this.worker = worker;
      return worker;
    } finally {
      this.workerStartPromise = null;
    }
  }

  private async startWorker(): Promise<Worker> {
    const script = await this.resolveWorkerScript();
    const worker = new this.WorkerClass(script.workerPath, {
      name: "git",
      workerData: {
        workerId: "git",
        sentryInitOptions: {
          buildFlavor: script.metadata.buildFlavor,
          appVersion: script.metadata.version,
          buildNumber: script.metadata.buildNumber,
          codexAppSessionId: this.codexAppSessionId,
        },
        maxLogLevel: process.env.POCODEX_DEBUG ? "debug" : "warning",
        sentryRewriteFramesRoot: script.metadata.appPath,
        spawnInsideWsl: false,
      },
    });

    worker.on("message", (message) => {
      if (isWorkerMainRpcRequestEnvelope(message)) {
        void this.handleMainRpcRequest(worker, message);
        return;
      }

      const responseId = extractWorkerResponseId(message);
      if (responseId) {
        this.pendingRequests.delete(responseId);
      }

      const workerError = extractWorkerErrorResponse(message);
      if (workerError) {
        console.error(`[git-worker] ${workerError.method} failed: ${workerError.error}`);
      }

      const workerStatusError = extractWorkerStatusError(message);
      if (workerStatusError) {
        console.error(
          `[git-worker] ${workerStatusError.method} failed: ${workerStatusError.error}`,
        );
      }

      this.emit("message", message);
    });

    worker.on("error", (error) => {
      this.emit("error", normalizeError(error));
    });

    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = null;
      }
      if (this.isClosing) {
        return;
      }

      const error = new Error(`Codex desktop git worker exited unexpectedly with code ${code}.`);
      const pending = [...this.pendingRequests.values()];
      this.pendingRequests.clear();
      for (const request of pending) {
        this.emit("message", buildWorkerErrorResponse(request, error));
      }
      this.emit("error", error);
    });

    worker.unref();

    debugLog("git-worker", "spawned desktop git worker", {
      workerPath: script.workerPath,
      version: script.metadata.version,
      subscribers: this.subscriberCount,
    });

    return worker;
  }

  private async handleMainRpcRequest(
    worker: Worker,
    message: WorkerMainRpcRequestEnvelope,
  ): Promise<void> {
    if (message.workerId !== "git") {
      return;
    }

    if (message.method === "worktree-cleanup-inputs") {
      const params = parseWorktreeCleanupInputs(message.params);
      worker.postMessage({
        type: "worker-main-rpc-response",
        workerId: "git",
        requestId: message.requestId,
        method: message.method,
        result: {
          type: "ok",
          value: {
            threadMetadataById: Object.fromEntries(
              params.threadIds.map((threadId) => [
                threadId,
                {
                  updatedAtMs: Date.now(),
                  isInProgress: true,
                },
              ]),
            ),
            pinnedThreadIds: [],
            protectPreMigrationOwnerlessWorktrees: false,
            autoCleanupEnabled: false,
            keepCount: 0,
          },
        },
      });
      return;
    }

    worker.postMessage({
      type: "worker-main-rpc-response",
      workerId: "git",
      requestId: message.requestId,
      method: message.method,
      result: {
        type: "error",
        error: {
          message: `Unsupported git worker main RPC method "${message.method}" in Pocodex.`,
        },
      },
    });
  }
}

function parseWorktreeCleanupInputs(value: unknown): WorktreeCleanupInputs {
  if (!isJsonRecord(value)) {
    return {
      hostKey: "local",
      threadIds: [],
    };
  }

  return {
    hostKey: typeof value.hostKey === "string" ? value.hostKey : "local",
    threadIds: Array.isArray(value.threadIds)
      ? value.threadIds.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function parseGitWorkerRequest(value: unknown): PendingWorkerRequest | null {
  if (!isJsonRecord(value) || value.type !== "worker-request") {
    return null;
  }
  const request = isJsonRecord(value.request) ? value.request : null;
  if (
    !request ||
    (typeof request.id !== "string" && typeof request.id !== "number") ||
    typeof request.method !== "string"
  ) {
    return null;
  }
  return {
    id: request.id,
    method: request.method,
  };
}

function parseGitWorkerCancel(value: unknown): { id: string | number } | null {
  if (!isJsonRecord(value) || value.type !== "worker-request-cancel") {
    return null;
  }
  if (typeof value.id !== "string" && typeof value.id !== "number") {
    return null;
  }
  return { id: value.id };
}

function buildWorkerErrorResponse(
  request: PendingWorkerRequest,
  error: Error,
): WorkerResponseEnvelope {
  return {
    type: "worker-response",
    workerId: "git",
    response: {
      id: request.id,
      method: request.method,
      result: {
        type: "error",
        error: {
          message: error.message,
        },
      },
    },
  };
}

function extractWorkerResponseId(message: unknown): string | null {
  if (!isJsonRecord(message) || message.type !== "worker-response") {
    return null;
  }
  const response = isJsonRecord(message.response) ? message.response : null;
  if (!response || (typeof response.id !== "string" && typeof response.id !== "number")) {
    return null;
  }
  return String(response.id);
}

function extractWorkerErrorResponse(message: unknown): {
  id: string;
  method: string;
  error: string;
} | null {
  if (!isJsonRecord(message) || message.type !== "worker-response") {
    return null;
  }

  const response = isJsonRecord(message.response) ? message.response : null;
  if (
    !response ||
    (typeof response.id !== "string" && typeof response.id !== "number") ||
    typeof response.method !== "string"
  ) {
    return null;
  }

  const result = isJsonRecord(response.result) ? response.result : null;
  if (!result || result.type !== "error") {
    return null;
  }

  const error = isJsonRecord(result.error) ? result.error : null;
  return {
    id: String(response.id),
    method: response.method,
    error:
      typeof error?.message === "string" && error.message.length > 0
        ? error.message
        : "Unknown worker error",
  };
}

function extractWorkerStatusError(message: unknown): {
  id: string;
  method: string;
  error: string;
} | null {
  if (!isJsonRecord(message) || message.type !== "worker-response") {
    return null;
  }

  const response = isJsonRecord(message.response) ? message.response : null;
  if (
    !response ||
    (typeof response.id !== "string" && typeof response.id !== "number") ||
    typeof response.method !== "string"
  ) {
    return null;
  }

  const result = isJsonRecord(response.result) ? response.result : null;
  if (!result) {
    return null;
  }

  const directStatusError = readStatusError(result);
  if (directStatusError) {
    return {
      id: String(response.id),
      method: response.method,
      error: directStatusError,
    };
  }

  const value = isJsonRecord(result.value) ? result.value : null;
  const nestedStatusError = value ? readStatusError(value) : null;
  if (!nestedStatusError) {
    return null;
  }

  return {
    id: String(response.id),
    method: response.method,
    error: nestedStatusError,
  };
}

function readStatusError(value: Record<string, unknown>): string | null {
  if (value.status !== "error") {
    return null;
  }

  if (typeof value.error === "string" && value.error.length > 0) {
    return value.error;
  }

  const execOutput = isJsonRecord(value.execOutput) ? value.execOutput : null;
  if (typeof execOutput?.output === "string" && execOutput.output.length > 0) {
    return execOutput.output;
  }

  return "Unknown worker status error";
}

function isWorkerMainRpcRequestEnvelope(value: unknown): value is WorkerMainRpcRequestEnvelope {
  return (
    isJsonRecord(value) &&
    value.type === "worker-main-rpc-request" &&
    typeof value.workerId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.method === "string"
  );
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
