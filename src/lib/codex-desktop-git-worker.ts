import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";

import { ensureCodexDesktopWorkerScript, type CodexDesktopWorkerScript } from "./codex-bundle.js";
import { listCodexHomePathCandidates } from "./codex-home.js";
import { debugLog, isDebugEnabled } from "./debug.js";

type GitWorkerMainRpcMethod =
  | "worktree-cleanup-inputs"
  | "fs-read-file"
  | "fs-write-file"
  | "fs-create-directory"
  | "fs-get-metadata"
  | "fs-read-directory"
  | "fs-remove"
  | "fs-copy"
  | "command-exec-start"
  | "command-exec-write"
  | "command-exec-resize"
  | "command-exec-terminate";

type CommandExecStream = "stdout" | "stderr";

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

interface CommandExecOutputDeltaEvent {
  processId: string;
  stream: CommandExecStream;
  delta: {
    chunk: Uint8Array;
    capReached: boolean;
  };
}

interface WorktreeCleanupInputs {
  hostKey: string;
  threadIds: string[];
}

interface FileReadParams {
  path: string;
}

interface FileWriteParams {
  path: string;
  dataBase64: string;
}

interface DirectoryCreateParams {
  path: string;
  recursive: boolean;
}

interface FileMetadataParams {
  path: string;
}

interface FileMetadataResult {
  isDirectory: boolean;
  isFile: boolean;
  createdAtMs: number;
  modifiedAtMs: number;
}

interface DirectoryReadParams {
  path: string;
}

interface DirectoryReadResult {
  entries: Array<{
    fileName: string;
    isDirectory: boolean;
    isFile: boolean;
  }>;
}

interface FileRemoveParams {
  path: string;
  recursive: boolean;
  force: boolean;
}

interface FileCopyParams {
  sourcePath: string;
  destinationPath: string;
  recursive: boolean;
}

interface CommandExecStartParams {
  processId: string;
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputBytesCap: number | null;
  disableOutputCap: boolean;
  timeoutMs: number | null;
  disableTimeout: boolean;
  streamStdoutStderr: boolean;
}

interface CommandExecWriteParams {
  processId: string;
  delta: Uint8Array;
  closeStdin: boolean;
}

interface CommandExecResizeParams {
  processId: string;
}

interface CommandExecTerminateParams {
  processId: string;
}

interface CommandExecSession {
  processId: string;
  child: ChildProcessWithoutNullStreams;
  outputLimitBytes: number | null;
  totalOutputBytes: number;
  streamStdoutStderr: boolean;
  timeout: NodeJS.Timeout | null;
}

type ApplyPatchTarget = "staged" | "staged-and-unstaged" | "unstaged";

interface ApplyPatchParams {
  cwd: string;
  diff: string;
  revert: boolean;
  target: ApplyPatchTarget;
  allowBinary: boolean;
  env: NodeJS.ProcessEnv;
}

interface ApplyPatchResult {
  status: "success" | "partial-success" | "error";
  appliedPaths: string[];
  skippedPaths: string[];
  conflictedPaths: string[];
  errorCode?: "not-git-repo";
  execOutput?: {
    command: string;
    output: string;
  };
}

interface GitCommandResult {
  command: string;
  code: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
}

interface PatchPathSnapshot {
  absolutePath: string;
  existed: boolean;
  contents: Buffer | null;
}

interface ApplyPatchPathOutcome {
  appliedPaths: string[];
  skippedPaths: string[];
  conflictedPaths: string[];
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

interface CodexWorktreeRecord {
  dir: string;
  gitDir: string | null;
}

interface ResolveWorktreeForThreadResult {
  worktreeGitRoot: string | null;
  worktreeWorkspaceRoot: string | null;
  hasUncommittedChanges: boolean;
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
  private readonly commandExecSessions = new Map<string, CommandExecSession>();
  private readonly localApplyPatchControllers = new Map<string, AbortController>();
  private readonly localWorktreeRequestControllers = new Map<string, AbortController>();
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
    let outgoingMessage = message;
    if (request) {
      this.pendingRequests.set(String(request.id), request);
      if (request.method === "apply-patch") {
        try {
          const params = parseApplyPatchParams(message);
          const controller = new AbortController();
          this.localApplyPatchControllers.set(String(request.id), controller);
          void this.handleLocalApplyPatchRequest(request, params, controller.signal);
        } catch (error) {
          const normalized = normalizeError(error);
          this.pendingRequests.delete(String(request.id));
          this.emit("message", buildWorkerErrorResponse(request, normalized));
        }
        return;
      }
      if (request.method === "codex-worktrees" && shouldHandleWorktreeRequestLocally(message)) {
        const controller = new AbortController();
        this.localWorktreeRequestControllers.set(String(request.id), controller);
        void this.handleLocalCodexWorktreesRequest(request, controller.signal);
        return;
      }
      if (
        request.method === "resolve-worktree-for-thread" &&
        shouldHandleWorktreeRequestLocally(message)
      ) {
        const controller = new AbortController();
        this.localWorktreeRequestControllers.set(String(request.id), controller);
        void this.handleLocalResolveWorktreeForThreadRequest(request, message, controller.signal);
        return;
      }
      outgoingMessage = maybeForceSettingsDeleteWorktreeRequest(message);
    } else {
      const cancellation = parseGitWorkerCancel(message);
      if (cancellation) {
        this.pendingRequests.delete(String(cancellation.id));
        const localApplyPatch = this.localApplyPatchControllers.get(String(cancellation.id));
        if (localApplyPatch) {
          this.localApplyPatchControllers.delete(String(cancellation.id));
          localApplyPatch.abort();
          return;
        }
        const localWorktreeRequest = this.localWorktreeRequestControllers.get(
          String(cancellation.id),
        );
        if (localWorktreeRequest) {
          this.localWorktreeRequestControllers.delete(String(cancellation.id));
          localWorktreeRequest.abort();
          return;
        }
      }
    }

    try {
      const worker = await this.ensureWorker();
      worker.postMessage(outgoingMessage);
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
    this.disposeCommandExecSessions();
    this.disposeLocalApplyPatchRequests();
    this.disposeLocalWorktreeRequests();
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
        maxLogLevel: isDebugEnabled("git-worker") ? "debug" : "warning",
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

      this.emit("message", message);
    });

    worker.on("error", (error) => {
      this.emit("error", normalizeError(error));
    });

    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = null;
      }
      this.disposeCommandExecSessions();
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

    try {
      switch (message.method as GitWorkerMainRpcMethod) {
        case "worktree-cleanup-inputs": {
          const params = parseWorktreeCleanupInputs(message.params);
          postMainRpcSuccess(worker, message, {
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
          });
          return;
        }
        case "fs-read-file": {
          const params = parseFileReadParams(message.params);
          const data = await readFile(params.path);
          postMainRpcSuccess(worker, message, {
            dataBase64: data.toString("base64"),
          });
          return;
        }
        case "fs-write-file": {
          const params = parseFileWriteParams(message.params);
          await writeFile(params.path, Buffer.from(params.dataBase64, "base64"));
          postMainRpcSuccess(worker, message, null);
          return;
        }
        case "fs-create-directory": {
          const params = parseDirectoryCreateParams(message.params);
          await mkdir(params.path, { recursive: params.recursive });
          postMainRpcSuccess(worker, message, null);
          return;
        }
        case "fs-get-metadata": {
          const params = parseFileMetadataParams(message.params);
          const stats = await stat(params.path);
          const metadata: FileMetadataResult = {
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            createdAtMs: Math.floor(stats.birthtimeMs || stats.ctimeMs),
            modifiedAtMs: Math.floor(stats.mtimeMs),
          };
          postMainRpcSuccess(worker, message, metadata);
          return;
        }
        case "fs-read-directory": {
          const params = parseDirectoryReadParams(message.params);
          const entries = await readdir(params.path, { withFileTypes: true });
          const result: DirectoryReadResult = {
            entries: entries.map((entry) => ({
              fileName: entry.name,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
            })),
          };
          postMainRpcSuccess(worker, message, result);
          return;
        }
        case "fs-remove": {
          const params = parseFileRemoveParams(message.params);
          await rm(params.path, {
            recursive: params.recursive,
            force: params.force,
          });
          postMainRpcSuccess(worker, message, null);
          return;
        }
        case "fs-copy": {
          const params = parseFileCopyParams(message.params);
          await cp(params.sourcePath, params.destinationPath, {
            recursive: params.recursive,
            force: true,
          });
          postMainRpcSuccess(worker, message, null);
          return;
        }
        case "command-exec-start": {
          this.startCommandExecSession(worker, message);
          return;
        }
        case "command-exec-write": {
          const params = parseCommandExecWriteParams(message.params);
          this.writeCommandExecSession(params);
          postMainRpcSuccess(worker, message, null);
          return;
        }
        case "command-exec-resize": {
          const params = parseCommandExecResizeParams(message.params);
          this.assertCommandExecSession(params.processId);
          postMainRpcSuccess(worker, message, null);
          return;
        }
        case "command-exec-terminate": {
          const params = parseCommandExecTerminateParams(message.params);
          this.terminateCommandExecSession(params.processId);
          postMainRpcSuccess(worker, message, null);
          return;
        }
      }
    } catch (error) {
      postMainRpcError(worker, message, normalizeError(error));
      return;
    }

    postMainRpcError(
      worker,
      message,
      new Error(`Unsupported git worker main RPC method "${message.method}" in Pocodex.`),
    );
  }

  private startCommandExecSession(worker: Worker, message: WorkerMainRpcRequestEnvelope): void {
    const params = parseCommandExecStartParams(message.params);
    if (this.commandExecSessions.has(params.processId)) {
      throw new Error(`Git worker command exec session "${params.processId}" already exists.`);
    }

    const [command, ...args] = params.command;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: params.cwd,
        env: params.env,
        stdio: "pipe",
      });
    } catch (error) {
      throw normalizeError(error);
    }

    const session: CommandExecSession = {
      processId: params.processId,
      child,
      outputLimitBytes:
        params.disableOutputCap || params.outputBytesCap === null ? null : params.outputBytesCap,
      totalOutputBytes: 0,
      streamStdoutStderr: params.streamStdoutStderr,
      timeout: null,
    };
    this.commandExecSessions.set(session.processId, session);

    let settled = false;
    const cleanup = () => {
      if (session.timeout) {
        clearTimeout(session.timeout);
        session.timeout = null;
      }
      this.commandExecSessions.delete(session.processId);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.removeAllListeners("close");
      child.removeAllListeners("error");
    };
    const settleSuccess = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      postMainRpcSuccess(worker, message, {
        exitCode,
      });
    };
    const settleError = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      postMainRpcError(worker, message, normalizeError(error));
    };

    child.stdout.on("data", (chunk) => {
      this.handleCommandExecOutput(worker, session, "stdout", toBuffer(chunk));
    });
    child.stderr.on("data", (chunk) => {
      this.handleCommandExecOutput(worker, session, "stderr", toBuffer(chunk));
    });
    child.once("error", (error) => {
      settleError(error);
    });
    child.once("close", (code) => {
      settleSuccess(typeof code === "number" ? code : null);
    });

    if (!params.disableTimeout && params.timeoutMs !== null) {
      session.timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, params.timeoutMs);
      session.timeout.unref();
    }
  }

  private handleCommandExecOutput(
    worker: Worker,
    session: CommandExecSession,
    stream: CommandExecStream,
    chunk: Buffer,
  ): void {
    if (!session.streamStdoutStderr || chunk.length === 0) {
      return;
    }

    let emittedChunk = chunk;
    let capReached = false;
    if (session.outputLimitBytes !== null) {
      const remainingBytes = session.outputLimitBytes - session.totalOutputBytes;
      if (remainingBytes <= 0) {
        capReached = true;
        emittedChunk = Buffer.alloc(0);
      } else if (chunk.length > remainingBytes) {
        capReached = true;
        emittedChunk = chunk.subarray(0, remainingBytes);
      }
    }

    session.totalOutputBytes += emittedChunk.length;
    if (emittedChunk.length > 0 || capReached) {
      postMainRpcEvent(worker, {
        processId: session.processId,
        stream,
        delta: {
          chunk: Uint8Array.from(emittedChunk),
          capReached,
        },
      });
    }

    if (capReached) {
      session.child.kill("SIGTERM");
    }
  }

  private writeCommandExecSession(params: CommandExecWriteParams): void {
    const session = this.assertCommandExecSession(params.processId);
    if (params.delta.byteLength > 0) {
      session.child.stdin.write(params.delta);
    }
    if (params.closeStdin) {
      session.child.stdin.end();
    }
  }

  private terminateCommandExecSession(processId: string): void {
    const session = this.assertCommandExecSession(processId);
    session.child.kill("SIGTERM");
  }

  private assertCommandExecSession(processId: string): CommandExecSession {
    const session = this.commandExecSessions.get(processId);
    if (!session) {
      throw new Error(`Git worker command exec session "${processId}" is not available.`);
    }
    return session;
  }

  private disposeCommandExecSessions(): void {
    for (const session of this.commandExecSessions.values()) {
      if (session.timeout) {
        clearTimeout(session.timeout);
      }
      session.child.stdout.removeAllListeners("data");
      session.child.stderr.removeAllListeners("data");
      session.child.removeAllListeners("close");
      session.child.removeAllListeners("error");
      session.child.kill("SIGTERM");
    }
    this.commandExecSessions.clear();
  }

  private async handleLocalApplyPatchRequest(
    request: PendingWorkerRequest,
    params: ApplyPatchParams,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const value = await applyPatchLocally(params, signal);
      if (!signal.aborted) {
        this.emit("message", buildWorkerSuccessResponse(request, value));
      }
    } catch (error) {
      if (!signal.aborted) {
        this.emit("message", buildWorkerErrorResponse(request, normalizeError(error)));
      }
    } finally {
      this.pendingRequests.delete(String(request.id));
      this.localApplyPatchControllers.delete(String(request.id));
    }
  }

  private disposeLocalApplyPatchRequests(): void {
    for (const controller of this.localApplyPatchControllers.values()) {
      controller.abort();
    }
    this.localApplyPatchControllers.clear();
  }

  private async handleLocalCodexWorktreesRequest(
    request: PendingWorkerRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const value = {
        worktrees: await listLocalCodexWorktrees(signal),
      };
      if (!signal.aborted) {
        this.emit("message", buildWorkerSuccessResponse(request, value));
      }
    } catch (error) {
      if (!signal.aborted) {
        this.emit("message", buildWorkerErrorResponse(request, normalizeError(error)));
      }
    } finally {
      this.pendingRequests.delete(String(request.id));
      this.localWorktreeRequestControllers.delete(String(request.id));
    }
  }

  private async handleLocalResolveWorktreeForThreadRequest(
    request: PendingWorkerRequest,
    message: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const params = parseResolveWorktreeForThreadParams(message);
      const value = await resolveWorktreeForThreadLocally(
        params.cwd,
        params.conversationId,
        signal,
      );
      if (!signal.aborted) {
        this.emit("message", buildWorkerSuccessResponse(request, value));
      }
    } catch (error) {
      if (!signal.aborted) {
        this.emit("message", buildWorkerErrorResponse(request, normalizeError(error)));
      }
    } finally {
      this.pendingRequests.delete(String(request.id));
      this.localWorktreeRequestControllers.delete(String(request.id));
    }
  }

  private disposeLocalWorktreeRequests(): void {
    for (const controller of this.localWorktreeRequestControllers.values()) {
      controller.abort();
    }
    this.localWorktreeRequestControllers.clear();
  }
}

async function applyPatchLocally(
  params: ApplyPatchParams,
  signal: AbortSignal,
): Promise<ApplyPatchResult> {
  const gitRoot = await resolveGitRoot(params.cwd, params.env, signal);
  if (!gitRoot) {
    return {
      status: "error",
      appliedPaths: [],
      skippedPaths: [],
      conflictedPaths: [],
      errorCode: "not-git-repo",
    };
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-"));
  const patchPath = join(tempDirectory, "patch.diff");
  const normalizedDiff = normalizePatchTextForApply(params.diff);
  await writeFile(patchPath, normalizedDiff, "utf8");

  try {
    let env = params.env;
    if (params.target === "unstaged") {
      const indexPath = await resolveGitIndexPath(gitRoot, env, signal);
      if (indexPath) {
        const tempIndexPath = join(tempDirectory, "index");
        await cp(indexPath, tempIndexPath, { force: true });
        env = {
          ...env,
          GIT_INDEX_FILE: tempIndexPath,
        };
        await prestagePatchPaths(gitRoot, normalizedDiff, env, signal);
      }
    }

    const applyArgs = ["apply"];
    if (params.revert) {
      applyArgs.push("-R");
    }
    if (params.allowBinary) {
      applyArgs.push("--binary");
    }
    applyArgs.push("--3way");
    if (params.target === "staged") {
      applyArgs.push("--cached");
    } else if (params.target === "staged-and-unstaged") {
      applyArgs.push("--index");
    }
    applyArgs.push(patchPath);

    const patchPaths = parsePatchPaths(normalizedDiff);
    const patchPathSnapshots =
      shouldPreparePatchUtilityFallback(params, patchPaths) && patchPaths.length > 0
        ? await snapshotPatchPaths(gitRoot, patchPaths)
        : null;
    const applyResult = await runGitCommand(gitRoot, applyArgs, {
      env,
      signal,
      allowedNonZeroExitCodes: [1],
    });
    const gitParsed = inferApplyPatchOutcome(
      parseGitApplyOutput(applyResult.stdout, applyResult.stderr),
      normalizedDiff,
      applyResult.code,
    );
    const patchFallback =
      shouldAttemptPatchUtilityFallback(params, applyResult.code, gitParsed) &&
      (await restoreAndTryApplyPatchFallbacks(
        gitRoot,
        patchPath,
        normalizedDiff,
        patchPaths,
        patchPathSnapshots,
        signal,
      ));
    const parsed = patchFallback
      ? mergeApplyPatchOutcomes(gitParsed, patchFallback.appliedPaths)
      : gitParsed;
    const execOutput = patchFallback
      ? {
          command: `${applyResult.command}\n${patchFallback.execOutput.command}`,
          output: [applyResult.stdout, applyResult.stderr, patchFallback.execOutput.output]
            .filter((value) => value.length > 0)
            .join("\n"),
        }
      : buildExecOutput(
          applyResult.command,
          applyResult.stdout,
          applyResult.stderr,
          "An unknown error occurred",
        );
    return {
      status: inferApplyPatchStatus(parsed, applyResult.code, signal.aborted),
      appliedPaths: parsed.appliedPaths,
      skippedPaths: parsed.skippedPaths,
      conflictedPaths: parsed.conflictedPaths,
      execOutput,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function mergeApplyPatchOutcomes(
  base: ApplyPatchPathOutcome,
  fallbackAppliedPaths: string[],
): ApplyPatchPathOutcome {
  const appliedPaths = new Set(base.appliedPaths);
  const skippedPaths = new Set(base.skippedPaths);
  const conflictedPaths = new Set(base.conflictedPaths);

  for (const path of fallbackAppliedPaths) {
    appliedPaths.add(path);
    skippedPaths.delete(path);
    conflictedPaths.delete(path);
  }

  return {
    appliedPaths: [...appliedPaths].sort(),
    skippedPaths: [...skippedPaths].sort(),
    conflictedPaths: [...conflictedPaths].sort(),
  };
}

function inferApplyPatchStatus(
  parsed: ApplyPatchPathOutcome,
  exitCode: number | null,
  aborted: boolean,
): ApplyPatchResult["status"] {
  if (aborted || exitCode === null) {
    return "error";
  }
  if (
    parsed.skippedPaths.length === 0 &&
    parsed.conflictedPaths.length === 0 &&
    (exitCode === 0 || parsed.appliedPaths.length > 0)
  ) {
    return "success";
  }
  if (exitCode === 1 || parsed.appliedPaths.length > 0) {
    return "partial-success";
  }
  return "error";
}

function inferApplyPatchOutcome(
  parsed: Pick<ApplyPatchResult, "appliedPaths" | "skippedPaths" | "conflictedPaths">,
  diff: string,
  exitCode: number | null,
): Pick<ApplyPatchResult, "appliedPaths" | "skippedPaths" | "conflictedPaths"> {
  if (
    exitCode !== 0 ||
    parsed.appliedPaths.length > 0 ||
    parsed.skippedPaths.length > 0 ||
    parsed.conflictedPaths.length > 0
  ) {
    return parsed;
  }

  const patchPaths = parsePatchPaths(diff);
  if (patchPaths.length === 0) {
    return parsed;
  }

  return {
    appliedPaths: patchPaths,
    skippedPaths: parsed.skippedPaths,
    conflictedPaths: parsed.conflictedPaths,
  };
}

function normalizePatchTextForApply(diff: string): string {
  const lines = diff.split("\n");
  const normalizedLines: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (!hunkMatch) {
      normalizedLines.push(line);
      index += 1;
      continue;
    }

    const oldStart = Number(hunkMatch[1]);
    const oldExpected = Number(hunkMatch[2] ?? "1");
    const newStart = Number(hunkMatch[3]);
    const newExpected = Number(hunkMatch[4] ?? "1");
    const trailingContext = hunkMatch[5] ?? "";
    const hunkBody: string[] = [];
    index += 1;

    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (
        candidate.startsWith("diff --git ") ||
        candidate.startsWith("--- ") ||
        candidate.startsWith("+++ ") ||
        candidate.startsWith("@@ ")
      ) {
        break;
      }
      hunkBody.push(candidate);
      index += 1;
    }

    const { oldCount, newCount } = countPatchHunkBodyLines(hunkBody);
    const oldDeficit = oldExpected - oldCount;
    const newDeficit = newExpected - newCount;
    if (oldDeficit > 0 && oldDeficit === newDeficit) {
      normalizedLines.push(
        `@@ ${formatPatchHunkRange("old", oldStart, oldCount)} ${formatPatchHunkRange("new", newStart, newCount)} @@${trailingContext}`,
      );
    } else {
      normalizedLines.push(line);
    }

    normalizedLines.push(...hunkBody);
  }

  return normalizedLines.join("\n");
}

function countPatchHunkBodyLines(lines: string[]): { oldCount: number; newCount: number } {
  let oldCount = 0;
  let newCount = 0;

  for (const line of lines) {
    if (line.startsWith("+")) {
      newCount += 1;
      continue;
    }
    if (line.startsWith("-")) {
      oldCount += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      oldCount += 1;
      newCount += 1;
      continue;
    }
  }

  return { oldCount, newCount };
}

function formatPatchHunkRange(kind: "old" | "new", start: number, count: number): string {
  const prefix = kind === "old" ? "-" : "+";
  return count === 1 ? `${prefix}${start}` : `${prefix}${start},${count}`;
}

function shouldAttemptPatchUtilityFallback(
  params: ApplyPatchParams,
  exitCode: number | null,
  parsed: Pick<ApplyPatchResult, "appliedPaths" | "skippedPaths" | "conflictedPaths">,
): boolean {
  return (
    shouldPreparePatchUtilityFallback(params, [
      ...parsed.appliedPaths,
      ...parsed.skippedPaths,
      ...parsed.conflictedPaths,
    ]) &&
    exitCode === 1 &&
    parsed.appliedPaths.length === 0 &&
    (parsed.skippedPaths.length > 0 || parsed.conflictedPaths.length > 0)
  );
}

function shouldPreparePatchUtilityFallback(
  params: ApplyPatchParams,
  patchPaths: string[],
): boolean {
  return (
    params.target === "unstaged" && params.revert && !params.allowBinary && patchPaths.length > 0
  );
}

async function snapshotPatchPaths(cwd: string, patchPaths: string[]): Promise<PatchPathSnapshot[]> {
  return Promise.all(
    patchPaths.map(async (patchPath) => {
      const absolutePath = resolvePath(cwd, patchPath);
      try {
        const fileMetadata = await stat(absolutePath);
        if (!fileMetadata.isFile()) {
          return {
            absolutePath,
            existed: false,
            contents: null,
          };
        }
        return {
          absolutePath,
          existed: true,
          contents: await readFile(absolutePath),
        };
      } catch {
        return {
          absolutePath,
          existed: false,
          contents: null,
        };
      }
    }),
  );
}

async function restorePatchPathSnapshots(snapshots: PatchPathSnapshot[]): Promise<void> {
  await Promise.all(
    snapshots.map(async (snapshot) => {
      if (!snapshot.existed) {
        await rm(snapshot.absolutePath, { recursive: true, force: true });
        return;
      }

      await mkdir(dirname(snapshot.absolutePath), { recursive: true });
      await writeFile(snapshot.absolutePath, snapshot.contents ?? Buffer.alloc(0));
    }),
  );
}

async function restoreAndTryApplyPatchFallbacks(
  cwd: string,
  patchPath: string,
  diff: string,
  patchPaths: string[],
  snapshots: PatchPathSnapshot[] | null,
  signal: AbortSignal,
): Promise<{ appliedPaths: string[]; execOutput: { command: string; output: string } } | null> {
  if (patchPaths.length === 0) {
    return null;
  }

  if (snapshots) {
    await restorePatchPathSnapshots(snapshots);
  }

  const patchUtilityResult = await tryApplyPatchWithPatchUtility(
    cwd,
    patchPath,
    patchPaths,
    signal,
  );
  if (patchUtilityResult) {
    return patchUtilityResult;
  }

  if (snapshots) {
    await restorePatchPathSnapshots(snapshots);
  }

  return tryApplyInsertionOnlyFallback(cwd, diff, patchPaths);
}

async function tryApplyPatchWithPatchUtility(
  cwd: string,
  patchPath: string,
  patchPaths: string[],
  signal: AbortSignal,
): Promise<{ appliedPaths: string[]; execOutput: { command: string; output: string } } | null> {
  const rejectPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const applyArgs = ["-R", "-p1", "-t", "-F", "3", "-r", rejectPath, "-i", patchPath];
  const applied = await runPatchCommand(cwd, applyArgs, { signal });
  if (!applied.success) {
    return null;
  }

  return {
    appliedPaths: patchPaths,
    execOutput: buildExecOutput(applied.command, applied.stdout, applied.stderr, "Patch applied."),
  };
}

interface DiffFileLineRange {
  path: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface InsertionOnlySequence {
  lines: string[];
  expectedStartOffset: number;
  leadingContext: string[];
  trailingContext: string[];
}

async function tryApplyInsertionOnlyFallback(
  cwd: string,
  diff: string,
  patchPaths: string[],
): Promise<{ appliedPaths: string[]; execOutput: { command: string; output: string } } | null> {
  const ranges = parseDiffFileLineRanges(diff);
  const changedPaths = new Set<string>();

  for (const patchPath of patchPaths) {
    const fileRanges = ranges
      .filter((range) => range.path === patchPath)
      .sort((left, right) => left.newStart - right.newStart);
    if (fileRanges.length === 0) {
      continue;
    }

    const absolutePath = resolvePath(cwd, patchPath);
    const originalText = await readFile(absolutePath, "utf8");
    const originalLines = originalText.split("\n");
    const updatedLines = [...originalLines];
    let fileChanged = false;
    let lineOffset = 0;

    for (const range of fileRanges) {
      const insertionSequences = extractInsertionOnlySequences(range.lines);
      if (insertionSequences.length === 0) {
        continue;
      }

      for (const sequence of insertionSequences) {
        const maxStartIndex = Math.max(0, updatedLines.length - sequence.lines.length);
        const expectedIndex = Math.max(
          0,
          Math.min(maxStartIndex, range.newStart - 1 + sequence.expectedStartOffset + lineOffset),
        );
        const matchIndex = findContiguousLineSequenceNearIndex(
          updatedLines,
          sequence,
          expectedIndex,
        );
        if (matchIndex < 0) {
          continue;
        }
        updatedLines.splice(matchIndex, sequence.lines.length);
        fileChanged = true;
        lineOffset -= sequence.lines.length;
      }
    }

    if (!fileChanged) {
      continue;
    }

    changedPaths.add(patchPath);
    await writeFile(absolutePath, updatedLines.join("\n"), "utf8");
  }

  if (changedPaths.size === 0) {
    return null;
  }

  const appliedPaths = [...changedPaths].sort();
  return {
    appliedPaths,
    execOutput: {
      command: "stale-hunk-insertion-fallback",
      output: `Removed stale inserted lines from ${appliedPaths.join(", ")}.`,
    },
  };
}

function parseDiffFileLineRanges(diff: string): DiffFileLineRange[] {
  const ranges: DiffFileLineRange[] = [];
  const lines = diff.split("\n");
  let currentPath: string | null = null;
  let activeRange: DiffFileLineRange | null = null;

  const pushActiveRange = () => {
    if (activeRange) {
      ranges.push(activeRange);
      activeRange = null;
    }
  };

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (diffMatch) {
      pushActiveRange();
      currentPath = normalizeDiffHeaderPath(diffMatch[2] || diffMatch[1]);
      continue;
    }

    const headerMatch = line.match(/^\+\+\+ (.+)$/);
    if (headerMatch) {
      currentPath = normalizeDiffHeaderPath(headerMatch[1]);
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentPath) {
      pushActiveRange();
      activeRange = {
        path: currentPath,
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        lines: [],
      };
      continue;
    }

    if (activeRange) {
      activeRange.lines.push(line);
    }
  }

  pushActiveRange();
  return ranges;
}

function normalizeDiffHeaderPath(rawPath: string | undefined): string | null {
  if (!rawPath) {
    return null;
  }

  const normalizedPath = stripOuterQuotes(rawPath.trim()).replace(/^a\//, "").replace(/^b\//, "");
  if (normalizedPath.length === 0 || normalizedPath === "/dev/null") {
    return null;
  }

  return normalizedPath;
}

function extractInsertionOnlySequences(hunkLines: string[]): InsertionOnlySequence[] {
  const sequences: InsertionOnlySequence[] = [];
  let newLineOffset = 0;

  for (let index = 0; index < hunkLines.length; ) {
    const line = hunkLines[index] ?? "";
    if (!line.startsWith("-") && !line.startsWith("+")) {
      if (line.startsWith(" ")) {
        newLineOffset += 1;
      }
      index += 1;
      continue;
    }

    const blockStartIndex = index;
    const blockStartOffset = newLineOffset;
    const removedBlock: string[] = [];
    const addedBlock: string[] = [];
    while (index < hunkLines.length) {
      const candidate = hunkLines[index] ?? "";
      if (candidate.startsWith("-")) {
        removedBlock.push(candidate.slice(1));
        index += 1;
        continue;
      }
      if (candidate.startsWith("+")) {
        addedBlock.push(candidate.slice(1));
        newLineOffset += 1;
        index += 1;
        continue;
      }
      break;
    }

    const insertionOnlyLines = getInsertionOnlyLines(removedBlock, addedBlock);
    if (insertionOnlyLines) {
      sequences.push({
        lines: insertionOnlyLines.lines,
        expectedStartOffset: blockStartOffset + insertionOnlyLines.startOffset,
        leadingContext: readAdjacentContextLines(hunkLines, blockStartIndex - 1, -1).reverse(),
        trailingContext: readAdjacentContextLines(hunkLines, index, 1),
      });
    }
  }

  return sequences;
}

function readAdjacentContextLines(hunkLines: string[], startIndex: number, step: -1 | 1): string[] {
  const contextLines: string[] = [];
  for (let index = startIndex; index >= 0 && index < hunkLines.length; index += step) {
    const line = hunkLines[index] ?? "";
    if (!line.startsWith(" ")) {
      break;
    }
    contextLines.push(line.slice(1));
  }
  return contextLines;
}

function scoreSequenceContextMatch(
  lines: string[],
  matchIndex: number,
  sequence: InsertionOnlySequence,
): number {
  let score = 0;
  for (let offset = 1; offset <= sequence.leadingContext.length; offset += 1) {
    const candidateLine = lines[matchIndex - offset];
    if (candidateLine === undefined) {
      break;
    }
    score += scoreLineSimilarity(
      sequence.leadingContext[sequence.leadingContext.length - offset]!,
      candidateLine,
    );
  }
  for (let offset = 0; offset < sequence.trailingContext.length; offset += 1) {
    const candidateLine = lines[matchIndex + sequence.lines.length + offset];
    if (candidateLine === undefined) {
      break;
    }
    score += scoreLineSimilarity(sequence.trailingContext[offset]!, candidateLine);
  }
  return score;
}

function getInsertionOnlyLines(
  removedLines: string[],
  addedLines: string[],
): { lines: string[]; startOffset: number } | null {
  if (addedLines.length <= removedLines.length) {
    return null;
  }

  const pairedAddedIndexes = new Set<number>();
  for (const removedLine of removedLines) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let index = 0; index < addedLines.length; index += 1) {
      if (pairedAddedIndexes.has(index)) {
        continue;
      }
      const score = scoreLineSimilarity(removedLine, addedLines[index]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestScore > 0) {
      pairedAddedIndexes.add(bestIndex);
    }
  }

  const unpairedAddedIndexes = addedLines.flatMap((_, index) =>
    pairedAddedIndexes.has(index) ? [] : [index],
  );
  if (unpairedAddedIndexes.length === 0) {
    return null;
  }

  return {
    lines: unpairedAddedIndexes.map((index) => addedLines[index]!),
    startOffset: unpairedAddedIndexes[0]!,
  };
}

function scoreLineSimilarity(left: string, right: string): number {
  let prefixLength = 0;
  while (
    prefixLength < left.length &&
    prefixLength < right.length &&
    left[prefixLength] === right[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < left.length - prefixLength &&
    suffixLength < right.length - prefixLength &&
    left[left.length - 1 - suffixLength] === right[right.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return prefixLength + suffixLength;
}

function findContiguousLineSequenceNearIndex(
  lines: string[],
  sequence: InsertionOnlySequence,
  expectedIndex: number,
): number {
  if (sequence.lines.length === 0 || lines.length < sequence.lines.length) {
    return -1;
  }

  let bestIndex = -1;
  let bestContextScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= lines.length - sequence.lines.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.lines.length; offset += 1) {
      if (lines[index + offset] !== sequence.lines[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }

    const contextScore = scoreSequenceContextMatch(lines, index, sequence);
    const distance = Math.abs(index - expectedIndex);
    if (
      contextScore > bestContextScore ||
      (contextScore === bestContextScore && distance < bestDistance)
    ) {
      bestIndex = index;
      bestContextScore = contextScore;
      bestDistance = distance;
      if (contextScore > 0 && distance === 0) {
        return index;
      }
    }
  }

  return bestIndex;
}

async function resolveGitRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runGitCommand(cwd, ["rev-parse", "--show-toplevel"], {
    env,
    signal,
    allowedNonZeroExitCodes: [128],
  });
  if (!result.success || result.stdout.length === 0) {
    return null;
  }
  return result.stdout;
}

async function resolveGitIndexPath(
  gitRoot: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runGitCommand(gitRoot, ["rev-parse", "--git-path", "index"], {
    env,
    signal,
    allowedNonZeroExitCodes: [128],
  });
  if (!result.success || result.stdout.length === 0) {
    return null;
  }

  return isAbsolute(result.stdout) ? result.stdout : resolvePath(gitRoot, result.stdout);
}

async function prestagePatchPaths(
  gitRoot: string,
  diff: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  const existingPaths: string[] = [];
  await Promise.all(
    parsePatchPaths(diff).map(async (patchPath) => {
      try {
        await stat(resolvePath(gitRoot, patchPath));
        existingPaths.push(patchPath);
      } catch {
        // Ignore files that do not exist in the working tree.
      }
    }),
  );
  if (existingPaths.length === 0) {
    return;
  }

  await runGitCommand(gitRoot, ["add", "--", ...existingPaths], {
    env,
    signal,
  });
}

async function runGitCommand(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    allowedNonZeroExitCodes?: number[];
  } = {},
): Promise<GitCommandResult> {
  const env = {
    ...process.env,
    LC_MESSAGES: "C",
    LANGUAGE: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...options.env,
  };
  const command = ["git", ...args].join(" ");

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("git", args, {
      cwd,
      env,
      stdio: "pipe",
    });
  } catch (error) {
    return {
      command,
      code: null,
      success: false,
      stdout: "",
      stderr: normalizeError(error).message,
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(toBuffer(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(toBuffer(chunk));
  });

  const abort = () => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort);

  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", (exitCode) => {
        resolve(typeof exitCode === "number" ? exitCode : null);
      });
    });
    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    return {
      command,
      code,
      success:
        code === 0 ||
        (typeof code === "number" && options.allowedNonZeroExitCodes?.includes(code) === true),
      stdout,
      stderr,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function runPatchCommand(
  cwd: string,
  args: string[],
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<GitCommandResult> {
  const env = {
    ...process.env,
    LC_MESSAGES: "C",
    LANGUAGE: "C",
  };
  const command = ["patch", ...args].join(" ");

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("patch", args, {
      cwd,
      env,
      stdio: "pipe",
    });
  } catch (error) {
    return {
      command,
      code: null,
      success: false,
      stdout: "",
      stderr: normalizeError(error).message,
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(toBuffer(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(toBuffer(chunk));
  });

  const abort = () => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort);

  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", (exitCode) => {
        resolve(typeof exitCode === "number" ? exitCode : null);
      });
    });
    return {
      command,
      code,
      success: code === 0,
      stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
      stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

function parsePatchPaths(diff: string): string[] {
  const paths = new Set<string>();
  const lines = diff.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const diffMatch = lines[index]?.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (diffMatch) {
      addPatchPath(paths, diffMatch[1]);
      addPatchPath(paths, diffMatch[2]);
      continue;
    }

    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    const oldMatch = oldHeader?.match(/^--- (.+)$/);
    const newMatch = newHeader?.match(/^\+\+\+ (.+)$/);
    if (!oldMatch || !newMatch) {
      continue;
    }

    addPatchPath(paths, oldMatch[1]);
    addPatchPath(paths, newMatch[1]);
    index += 1;
  }

  return [...paths];
}

function addPatchPath(paths: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) {
    return;
  }

  const normalizedPath = stripOuterQuotes(rawPath.trim()).replace(/^a\//, "").replace(/^b\//, "");
  if (normalizedPath.length === 0 || normalizedPath === "/dev/null") {
    return;
  }

  paths.add(normalizedPath);
}

function parseGitApplyOutput(
  stdout: string,
  stderr: string,
): Pick<ApplyPatchResult, "appliedPaths" | "skippedPaths" | "conflictedPaths"> {
  const appliedPaths = new Set<string>();
  const skippedPaths = new Set<string>();
  const conflictedPaths = new Set<string>();
  let activePath: string | null = null;

  const readMatchPath = (match: RegExpMatchArray): string | null => {
    const path = match.groups?.qpath ?? match.groups?.path ?? "";
    const normalizedPath = path.trim();
    return normalizedPath.length > 0 ? normalizedPath : null;
  };
  const addPath = (paths: Set<string>, path: string | null): void => {
    if (path) {
      paths.add(stripOuterQuotes(path));
    }
  };

  const appliedPattern =
    /^(?:Applied patch(?: to)?\s+(?:(["'])(?<qpath>.+?)\1|(?<path>.+?))\s+cleanly\.?)$/i;
  const conflictPattern =
    /^(?:Applied patch(?: to)?\s+(?:(["'])(?<qpath>.+?)\1|(?<path>.+?))\s+with conflicts\.?)$/i;
  const rejectPattern =
    /^(?:Applying patch\s+(?:(["'])(?<qpath>.+?)\1|(?<path>.+?))\s+with\s+\d+\s+rejects?\.{0,3})$/i;
  const checkingPattern = /^(?:Checking patch\s+(?:(["'])(?<qpath>.+?)\1|(?<path>.+?))\.\.\.)$/i;
  const unresolvedPattern = /^U\s+(?<path>.+)$/;
  const patchFailedPattern = /^error:\s+patch failed:\s+(?<path>.+?)(?::\d+)?(?:\s|$)/i;
  const doesNotApplyPattern = /^error:\s+(?<path>.+?):\s+patch does not apply$/i;
  const threeWayFailurePattern = /^Failed to perform three-way merge\.\.\.$/i;
  const missingBlobPattern =
    /^(?:error: )?repository lacks the necessary blob to (?:perform|fall back on) 3-?way merge\.?$/i;
  const doesNotMatchIndexPattern = /^error:\s+(?<path>.+?):\s+does not match index\b/i;
  const doesNotExistInIndexPattern = /^error:\s+(?<path>.+?):\s+does not exist in index\b/i;
  const alreadyExistsPattern =
    /^error:\s+(?<path>.+?)\s+already exists in (?:the )?working directory\b/i;
  const fileExistsPattern = /^error:\s+patch failed:\s+(?<path>.+?)\s+File exists/i;
  const renamedDeletedPattern = /^error:\s+path\s+(?<path>.+?)\s+has been renamed\/deleted/i;
  const binaryIndexPattern =
    /^error:\s+cannot apply binary patch to\s+['"]?(?<path>.+?)['"]?\s+without full index line$/i;
  const binaryDoesNotApplyPattern =
    /^error:\s+binary patch does not apply to\s+['"]?(?<path>.+?)['"]?$/i;
  const binaryIncorrectResultPattern =
    /^error:\s+binary patch to\s+['"]?(?<path>.+?)['"]?\s+creates incorrect result\b/i;
  const cannotReadCurrentContentsPattern =
    /^error:\s+cannot read the current contents of\s+['"]?(?<path>.+?)['"]?$/i;
  const skippedPatchPattern = /^Skipped patch\s+['"]?(?<path>.+?)['"]\.$/i;
  const binaryConflictWarningPattern =
    /^warning:\s*Cannot merge binary files:\s+(?<path>.+?)\s+\(ours\s+vs\.\s+theirs\)/i;
  const ignoredProgressPattern =
    /^(?:Performing three-way merge|Falling back to direct application)\.\.\.$/i;

  for (const line of [stdout, stderr].filter(Boolean).join("\n").split(/\r?\n/)) {
    const text = line.trim();
    if (!text) {
      continue;
    }

    let match: RegExpMatchArray | null;
    if ((match = text.match(appliedPattern))) {
      const path = readMatchPath(match);
      addPath(appliedPaths, path);
      activePath = path;
      conflictedPaths.delete(path ?? "");
      skippedPaths.delete(path ?? "");
      continue;
    }
    if ((match = text.match(conflictPattern))) {
      const path = readMatchPath(match);
      addPath(conflictedPaths, path);
      activePath = path;
      appliedPaths.delete(path ?? "");
      skippedPaths.delete(path ?? "");
      continue;
    }
    if ((match = text.match(rejectPattern))) {
      const path = readMatchPath(match);
      addPath(conflictedPaths, path);
      activePath = path;
      appliedPaths.delete(path ?? "");
      skippedPaths.delete(path ?? "");
      continue;
    }
    if ((match = text.match(unresolvedPattern))) {
      const path = match.groups?.path ?? null;
      addPath(conflictedPaths, path);
      activePath = path;
      appliedPaths.delete(path ?? "");
      skippedPaths.delete(path ?? "");
      continue;
    }
    if ((match = text.match(checkingPattern))) {
      activePath = readMatchPath(match);
      continue;
    }
    if ((match = text.match(patchFailedPattern)) || (match = text.match(doesNotApplyPattern))) {
      const path = match.groups?.path ?? null;
      addPath(skippedPaths, path);
      activePath = path;
      continue;
    }
    if (ignoredProgressPattern.test(text)) {
      continue;
    }
    if (threeWayFailurePattern.test(text) || missingBlobPattern.test(text)) {
      addPath(skippedPaths, activePath);
      appliedPaths.delete(activePath ?? "");
      conflictedPaths.delete(activePath ?? "");
      continue;
    }
    if (
      (match = text.match(doesNotMatchIndexPattern)) ||
      (match = text.match(doesNotExistInIndexPattern)) ||
      (match = text.match(alreadyExistsPattern)) ||
      (match = text.match(fileExistsPattern)) ||
      (match = text.match(renamedDeletedPattern)) ||
      (match = text.match(binaryIndexPattern)) ||
      (match = text.match(binaryDoesNotApplyPattern)) ||
      (match = text.match(binaryIncorrectResultPattern)) ||
      (match = text.match(cannotReadCurrentContentsPattern)) ||
      (match = text.match(skippedPatchPattern))
    ) {
      const path = match.groups?.path ?? null;
      addPath(skippedPaths, path);
      activePath = path;
      appliedPaths.delete(path ?? "");
      conflictedPaths.delete(path ?? "");
      continue;
    }
    if ((match = text.match(binaryConflictWarningPattern))) {
      const path = match.groups?.path ?? null;
      addPath(conflictedPaths, path);
      activePath = path;
      appliedPaths.delete(path ?? "");
      skippedPaths.delete(path ?? "");
    }
  }

  for (const path of conflictedPaths) {
    appliedPaths.delete(path);
    skippedPaths.delete(path);
  }
  for (const path of appliedPaths) {
    skippedPaths.delete(path);
  }

  return {
    appliedPaths: [...appliedPaths].sort(),
    skippedPaths: [...skippedPaths].sort(),
    conflictedPaths: [...conflictedPaths].sort(),
  };
}

function buildExecOutput(
  command: string,
  stdout: string,
  stderr: string,
  fallbackOutput: string,
): { command: string; output: string } {
  const output = [stdout, stderr].filter((value) => value.length > 0).join("\n");
  return {
    command,
    output: output || fallbackOutput,
  };
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && ['"', "'"].includes(trimmed[0]!)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shouldHandleWorktreeRequestLocally(value: unknown): boolean {
  return isLocalHostConfigValue(readGitWorkerRequestParams(value)?.hostConfig);
}

function maybeForceSettingsDeleteWorktreeRequest(value: unknown): unknown {
  const envelope = isJsonRecord(value) ? value : null;
  const params = readGitWorkerRequestParams(value);
  if (!envelope || !params || !isLocalHostConfigValue(params.hostConfig)) {
    return value;
  }

  const request = isJsonRecord(envelope.request) ? envelope.request : null;
  if (request?.method !== "delete-worktree") {
    return value;
  }

  const reason = typeof params.reason === "string" ? params.reason : "";
  if (!reason.startsWith("settings-delete") || params.force === true) {
    return value;
  }

  return {
    ...envelope,
    request: {
      ...request,
      params: {
        ...params,
        force: true,
      },
    },
  };
}

function readGitWorkerRequestParams(value: unknown): Record<string, unknown> | null {
  if (!isJsonRecord(value) || value.type !== "worker-request") {
    return null;
  }

  const request = isJsonRecord(value.request) ? value.request : null;
  if (!request) {
    return null;
  }

  return isJsonRecord(request.params) ? request.params : {};
}

function isLocalHostConfigValue(value: unknown): boolean {
  return (
    !isJsonRecord(value) ||
    value.kind === undefined ||
    value.kind === "local" ||
    value.kind === "git"
  );
}

function parseResolveWorktreeForThreadParams(value: unknown): {
  cwd: string;
  conversationId: string;
} {
  const record = assertJsonRecord(
    readGitWorkerRequestParams(value),
    "resolve-worktree-for-thread params",
  );
  return {
    cwd: readRequiredString(record.cwd, "cwd"),
    conversationId: readRequiredString(record.conversationId, "conversationId"),
  };
}

async function listLocalCodexWorktrees(signal: AbortSignal): Promise<CodexWorktreeRecord[]> {
  const seenDirs = new Set<string>();
  const worktrees: CodexWorktreeRecord[] = [];

  for (const codexHome of listCodexHomePathCandidates()) {
    for (const worktree of await listLocalCodexWorktreesForHome(codexHome, signal)) {
      const key = normalizeComparablePath(worktree.dir);
      if (seenDirs.has(key)) {
        continue;
      }
      seenDirs.add(key);
      worktrees.push(worktree);
    }
  }

  worktrees.sort((left, right) => left.dir.localeCompare(right.dir));
  return worktrees;
}

async function listLocalCodexWorktreesForHome(
  codexHome: string,
  signal: AbortSignal,
): Promise<CodexWorktreeRecord[]> {
  assertNotAborted(signal);

  const worktreesRoot = join(codexHome, "worktrees");
  let parentEntries;
  try {
    parentEntries = await readdir(worktreesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const worktrees: CodexWorktreeRecord[] = [];
  for (const parentEntry of parentEntries) {
    assertNotAborted(signal);
    if (!parentEntry.isDirectory()) {
      continue;
    }

    const parentPath = join(worktreesRoot, parentEntry.name);
    let worktreeEntries;
    try {
      worktreeEntries = await readdir(parentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const worktreeEntry of worktreeEntries) {
      assertNotAborted(signal);
      if (!worktreeEntry.isDirectory()) {
        continue;
      }

      const worktreeDir = resolvePath(parentPath, worktreeEntry.name);
      worktrees.push({
        dir: worktreeDir,
        gitDir: await resolveLocalGitDir(worktreeDir, signal),
      });
    }
  }

  return worktrees;
}

async function resolveWorktreeForThreadLocally(
  cwd: string,
  conversationId: string,
  signal: AbortSignal,
): Promise<ResolveWorktreeForThreadResult> {
  const gitRoot = await resolveGitRoot(cwd, process.env, signal);
  if (!gitRoot) {
    return {
      worktreeGitRoot: null,
      worktreeWorkspaceRoot: null,
      hasUncommittedChanges: false,
    };
  }

  const relativeWorkspacePath = relative(gitRoot, cwd);
  const worktreeRoots = await listGitWorktreeRoots(gitRoot, signal);
  const codexWorktreesRootPrefixes = listCodexHomePathCandidates().map((codexHome) =>
    normalizeComparablePath(join(codexHome, "worktrees")),
  );
  const candidates: Array<{
    worktreeGitRoot: string;
    worktreeWorkspaceRoot: string;
    sortTimestamp: number;
  }> = [];

  for (const worktreeRoot of worktreeRoots) {
    assertNotAborted(signal);
    if (!isPathWithinAnyPrefix(worktreeRoot, codexWorktreesRootPrefixes)) {
      continue;
    }

    const ownerThreadId = await readLocalWorktreeOwnerThreadId(worktreeRoot, signal);
    if (ownerThreadId !== conversationId) {
      continue;
    }

    const worktreeWorkspaceRoot = isNestedRelativePath(relativeWorkspacePath)
      ? resolvePath(worktreeRoot, relativeWorkspacePath)
      : worktreeRoot;
    candidates.push({
      worktreeGitRoot: worktreeRoot,
      worktreeWorkspaceRoot,
      sortTimestamp: await readSortTimestamp(worktreeRoot),
    });
  }

  if (candidates.length === 0) {
    return {
      worktreeGitRoot: null,
      worktreeWorkspaceRoot: null,
      hasUncommittedChanges: false,
    };
  }

  candidates.sort((left, right) => {
    if (left.sortTimestamp === right.sortTimestamp) {
      return right.worktreeGitRoot.localeCompare(left.worktreeGitRoot);
    }
    return right.sortTimestamp - left.sortTimestamp;
  });

  const selected = candidates[0]!;
  const status = await runGitCommand(selected.worktreeWorkspaceRoot, ["status", "--porcelain"], {
    env: process.env,
    signal,
    allowedNonZeroExitCodes: [128],
  });
  return {
    worktreeGitRoot: selected.worktreeGitRoot,
    worktreeWorkspaceRoot: selected.worktreeWorkspaceRoot,
    hasUncommittedChanges: status.success && status.stdout.length > 0,
  };
}

async function listGitWorktreeRoots(gitRoot: string, signal: AbortSignal): Promise<string[]> {
  const output = await runGitCommand(gitRoot, ["worktree", "list", "--porcelain"], {
    env: process.env,
    signal,
  });
  if (!output.success) {
    throw new Error(output.stderr || output.stdout || "Failed to list git worktrees.");
  }

  const roots = new Set<string>();
  for (const line of output.stdout.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const worktreeRoot = line.slice("worktree ".length).trim();
    if (worktreeRoot.length === 0) {
      continue;
    }
    roots.add(resolvePath(worktreeRoot));
  }
  return [...roots];
}

async function readLocalWorktreeOwnerThreadId(
  worktreeRoot: string,
  signal: AbortSignal,
): Promise<string | null> {
  const configPath = await resolveLocalGitPath(worktreeRoot, "codex-thread.json", signal);
  if (!configPath) {
    return null;
  }

  try {
    const rawConfig = await readFile(configPath, "utf8");
    const parsed = JSON.parse(rawConfig);
    return typeof parsed?.ownerThreadId === "string" ? parsed.ownerThreadId : null;
  } catch {
    return null;
  }
}

async function resolveLocalGitDir(
  worktreeRoot: string,
  signal: AbortSignal,
): Promise<string | null> {
  return resolveLocalGitPath(worktreeRoot, ".git", signal, ["rev-parse", "--git-dir"]);
}

async function resolveLocalGitPath(
  worktreeRoot: string,
  gitPath: string,
  signal: AbortSignal,
  command: string[] = ["rev-parse", "--git-path", gitPath],
): Promise<string | null> {
  const result = await runGitCommand(worktreeRoot, command, {
    env: process.env,
    signal,
    allowedNonZeroExitCodes: [128],
  });
  if (!result.success || result.stdout.length === 0) {
    return null;
  }

  return isAbsolute(result.stdout) ? result.stdout : resolvePath(worktreeRoot, result.stdout);
}

async function readSortTimestamp(path: string): Promise<number> {
  try {
    const stats = await stat(path);
    if (stats.birthtimeMs > 0) {
      return Math.floor(stats.birthtimeMs);
    }
    return Math.floor(stats.mtimeMs);
  } catch {
    return 0;
  }
}

function isPathWithinAnyPrefix(path: string, prefixes: string[]): boolean {
  const normalizedPath = normalizeComparablePath(path);
  return prefixes.some((prefix) => {
    if (normalizedPath === prefix) {
      return true;
    }
    return normalizedPath.startsWith(`${prefix}/`);
  });
}

function isNestedRelativePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !/^\.\.(?:[\\/]|$)/.test(value);
}

function normalizeComparablePath(value: string): string {
  return resolvePath(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Operation canceled");
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

function parseFileReadParams(value: unknown): FileReadParams {
  const record = assertJsonRecord(value, "fs-read-file params");
  return {
    path: readRequiredString(record.path, "path"),
  };
}

function parseFileWriteParams(value: unknown): FileWriteParams {
  const record = assertJsonRecord(value, "fs-write-file params");
  return {
    path: readRequiredString(record.path, "path"),
    dataBase64: typeof record.dataBase64 === "string" ? record.dataBase64 : "",
  };
}

function parseDirectoryCreateParams(value: unknown): DirectoryCreateParams {
  const record = assertJsonRecord(value, "fs-create-directory params");
  return {
    path: readRequiredString(record.path, "path"),
    recursive: Boolean(record.recursive),
  };
}

function parseFileMetadataParams(value: unknown): FileMetadataParams {
  const record = assertJsonRecord(value, "fs-get-metadata params");
  return {
    path: readRequiredString(record.path, "path"),
  };
}

function parseDirectoryReadParams(value: unknown): DirectoryReadParams {
  const record = assertJsonRecord(value, "fs-read-directory params");
  return {
    path: readRequiredString(record.path, "path"),
  };
}

function parseFileRemoveParams(value: unknown): FileRemoveParams {
  const record = assertJsonRecord(value, "fs-remove params");
  return {
    path: readRequiredString(record.path, "path"),
    recursive: Boolean(record.recursive),
    force: Boolean(record.force),
  };
}

function parseFileCopyParams(value: unknown): FileCopyParams {
  const record = assertJsonRecord(value, "fs-copy params");
  return {
    sourcePath: readRequiredString(record.sourcePath, "sourcePath"),
    destinationPath: readRequiredString(record.destinationPath, "destinationPath"),
    recursive: Boolean(record.recursive),
  };
}

function parseCommandExecStartParams(value: unknown): CommandExecStartParams {
  const record = assertJsonRecord(value, "command-exec-start params");
  const command = Array.isArray(record.command)
    ? record.command.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (command.length === 0) {
    throw new Error('Missing non-empty "command" array for command-exec-start.');
  }

  return {
    processId:
      typeof record.processId === "string" && record.processId.length > 0
        ? record.processId
        : randomUUID(),
    command,
    cwd: typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd(),
    env: parseCommandExecEnv(record.env),
    outputBytesCap: readOptionalPositiveInteger(record.outputBytesCap),
    disableOutputCap: Boolean(record.disableOutputCap),
    timeoutMs: readOptionalPositiveInteger(record.timeoutMs),
    disableTimeout: Boolean(record.disableTimeout),
    streamStdoutStderr: Boolean(record.streamStdoutStderr),
  };
}

function parseCommandExecWriteParams(value: unknown): CommandExecWriteParams {
  const record = assertJsonRecord(value, "command-exec-write params");
  return {
    processId: readRequiredString(record.processId, "processId"),
    delta: toUint8Array(record.delta),
    closeStdin: Boolean(record.closeStdin),
  };
}

function parseCommandExecResizeParams(value: unknown): CommandExecResizeParams {
  const record = assertJsonRecord(value, "command-exec-resize params");
  return {
    processId: readRequiredString(record.processId, "processId"),
  };
}

function parseCommandExecTerminateParams(value: unknown): CommandExecTerminateParams {
  const record = assertJsonRecord(value, "command-exec-terminate params");
  return {
    processId: readRequiredString(record.processId, "processId"),
  };
}

function parseCommandExecEnv(value: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!isJsonRecord(value)) {
    return env;
  }

  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      env[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      env[key] = String(rawValue);
      continue;
    }
    if (rawValue === null) {
      delete env[key];
    }
  }

  return env;
}

function parseApplyPatchParams(value: unknown): ApplyPatchParams {
  const envelope = assertJsonRecord(value, "apply-patch request");
  const request = assertJsonRecord(envelope.request, "apply-patch request");
  const record = assertJsonRecord(request.params, "apply-patch params");

  const target =
    record.target === "staged" ||
    record.target === "staged-and-unstaged" ||
    record.target === "unstaged"
      ? record.target
      : "unstaged";

  return {
    cwd: readRequiredString(record.cwd, "cwd"),
    diff: typeof record.diff === "string" ? record.diff : "",
    revert: Boolean(record.revert),
    target,
    allowBinary: Boolean(record.allowBinary),
    env: parseCommandExecEnv(record.env),
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

function buildWorkerSuccessResponse(
  request: PendingWorkerRequest,
  value: unknown,
): WorkerResponseEnvelope {
  return {
    type: "worker-response",
    workerId: "git",
    response: {
      id: request.id,
      method: request.method,
      result: {
        type: "ok",
        value,
      },
    },
  };
}

function postMainRpcSuccess(
  worker: Worker,
  message: WorkerMainRpcRequestEnvelope,
  value: unknown,
): void {
  worker.postMessage({
    type: "worker-main-rpc-response",
    workerId: "git",
    requestId: message.requestId,
    method: message.method,
    result: {
      type: "ok",
      value,
    },
  });
}

function postMainRpcError(
  worker: Worker,
  message: WorkerMainRpcRequestEnvelope,
  error: Error,
): void {
  worker.postMessage({
    type: "worker-main-rpc-response",
    workerId: "git",
    requestId: message.requestId,
    method: message.method,
    result: {
      type: "error",
      error: {
        message: error.message,
      },
    },
  });
}

function postMainRpcEvent(worker: Worker, event: CommandExecOutputDeltaEvent): void {
  worker.postMessage({
    type: "worker-main-rpc-event",
    workerId: "git",
    method: "command-exec-output-delta",
    params: event,
  });
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

function isWorkerMainRpcRequestEnvelope(value: unknown): value is WorkerMainRpcRequestEnvelope {
  return (
    isJsonRecord(value) &&
    value.type === "worker-main-rpc-request" &&
    typeof value.workerId === "string" &&
    typeof value.requestId === "string" &&
    typeof value.method === "string"
  );
}

function assertJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isJsonRecord(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing required "${label}" string.`);
}

function readOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0)) {
    return Uint8Array.from(value);
  }
  if (
    isJsonRecord(value) &&
    value.type === "Buffer" &&
    Array.isArray(value.data) &&
    value.data.every((item) => Number.isInteger(item) && item >= 0)
  ) {
    return Uint8Array.from(value.data);
  }
  return new Uint8Array(0);
}

function toBuffer(value: unknown): Buffer {
  return Buffer.from(toUint8Array(value));
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
