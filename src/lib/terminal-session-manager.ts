import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IDisposable, IPty } from "node-pty";

import type { JsonRecord } from "./protocol.js";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_SHELL = "/bin/zsh";
const TERMINAL_BUFFER_LIMIT = 64 * 1024;
const TERMINAL_NAME = "xterm-256color";

export interface TerminalCreateMessage {
  sessionId?: unknown;
  conversationId?: unknown;
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
  _pocodexBrowserSessionId?: unknown;
  _pocodexBrowserTerminalSessionId?: unknown;
}

export interface TerminalAttachMessage {
  sessionId?: unknown;
  conversationId?: unknown;
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
  forceCwdSync?: unknown;
  _pocodexBrowserSessionId?: unknown;
  _pocodexBrowserTerminalSessionId?: unknown;
}

export interface TerminalWriteMessage {
  sessionId?: unknown;
  data?: unknown;
  _pocodexBrowserSessionId?: unknown;
  _pocodexBrowserTerminalSessionId?: unknown;
}

export interface TerminalRunActionMessage {
  sessionId?: unknown;
  cwd?: unknown;
  command?: unknown;
  _pocodexBrowserSessionId?: unknown;
  _pocodexBrowserTerminalSessionId?: unknown;
}

export interface TerminalResizeMessage {
  sessionId?: unknown;
  cols?: unknown;
  rows?: unknown;
  _pocodexBrowserSessionId?: unknown;
  _pocodexBrowserTerminalSessionId?: unknown;
}

export interface TerminalCloseMessage {
  sessionId?: unknown;
  _pocodexBrowserSessionId?: unknown;
  _pocodexBrowserTerminalSessionId?: unknown;
}

interface TerminalCreateOrAttachRequest {
  sessionId: string | null;
  conversationId: string | null;
  cwd: string | null;
  cols: number;
  rows: number;
  forceCwdSync: boolean;
  browserSessionId: string | null;
  browserTerminalSessionId: string | null;
}

interface TerminalRoutingTarget {
  browserSessionId: string | null;
  browserTerminalSessionId: string | null;
}

interface TerminalSession {
  id: string;
  pty: IPty;
  cwd: string;
  shell: string;
  buffer: string;
  conversationId: string | null;
  dataSubscription: IDisposable;
  exitSubscription: IDisposable;
}

interface TerminalSessionManagerOptions {
  cwd: string;
  emitBridgeMessage: (message: JsonRecord) => void;
}

let nodePtyModulePromise: Promise<typeof import("node-pty")> | null = null;
let nodePtySpawnHelperPrepared = false;
let nodePtyRebuildAttempted = false;

export class TerminalSessionManager {
  private readonly cwd: string;
  private readonly emitBridgeMessage: (message: JsonRecord) => void;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly sessionsByConversation = new Map<string, string>();

  constructor(options: TerminalSessionManagerOptions) {
    this.cwd = options.cwd;
    this.emitBridgeMessage = options.emitBridgeMessage;
  }

  async handleCreate(message: TerminalCreateMessage): Promise<void> {
    const request = normalizeCreateOrAttachRequest(message);
    const existing = this.getExistingSession(request);
    if (existing) {
      this.attachSession(existing, request);
      return;
    }

    await this.createSession(request);
  }

  async handleAttach(message: TerminalAttachMessage): Promise<void> {
    const request = normalizeCreateOrAttachRequest(message);
    const existing = this.getExistingSession(request);
    if (existing) {
      this.attachSession(existing, request);
      return;
    }

    await this.createSession(request);
  }

  write(message: TerminalWriteMessage): void {
    const sessionId = readString(message.sessionId);
    const data = typeof message.data === "string" ? message.data : null;
    const routingTarget = readTerminalRoutingTarget(message);
    if (!sessionId || data === null) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendError(sessionId, "Terminal session is not available.", routingTarget);
      return;
    }

    this.performPtyAction(
      sessionId,
      session,
      () => {
        session.pty.write(data);
      },
      routingTarget,
    );
  }

  runAction(message: TerminalRunActionMessage): void {
    const sessionId = readString(message.sessionId);
    const routingTarget = readTerminalRoutingTarget(message);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendError(sessionId, "Terminal session is not available.", routingTarget);
      return;
    }

    const requestedCwd = readString(message.cwd) ?? session.cwd;
    const localCwd = this.resolveLocalCwd(requestedCwd);
    const command = typeof message.command === "string" ? message.command : "";

    this.performPtyAction(
      sessionId,
      session,
      () => {
        session.cwd = localCwd;
        session.pty.write(buildRunActionCommand(localCwd, command));
      },
      routingTarget,
    );
  }

  resize(message: TerminalResizeMessage): void {
    const sessionId = readString(message.sessionId);
    const routingTarget = readTerminalRoutingTarget(message);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const cols = readPositiveInteger(message.cols);
    const rows = readPositiveInteger(message.rows);
    if (cols === null || rows === null) {
      return;
    }

    this.performPtyAction(
      sessionId,
      session,
      () => {
        session.pty.resize(cols, rows);
      },
      routingTarget,
    );
  }

  close(message: TerminalCloseMessage): void {
    const sessionId = readString(message.sessionId);
    const routingTarget = readTerminalRoutingTarget(message);
    if (!sessionId) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendError(sessionId, "Terminal session is not available.", routingTarget);
      return;
    }

    this.destroySession(session, {
      emitExit: true,
      killPty: true,
      code: null,
      signal: null,
    });
  }

  dispose(): void {
    for (const session of Array.from(this.sessions.values())) {
      this.destroySession(session, {
        emitExit: false,
        killPty: true,
        code: null,
        signal: null,
      });
    }
  }

  private async createSession(request: TerminalCreateOrAttachRequest): Promise<void> {
    const sessionId = request.sessionId ?? randomUUID();
    const shell = resolveShell();
    const cwd = this.resolveLocalCwd(request.cwd);
    const env = buildTerminalEnv();

    try {
      const { spawn } = await loadNodePty();
      ensureNodePtySpawnHelperIsExecutable();
      const pty = spawn(shell, [], {
        name: TERMINAL_NAME,
        cols: request.cols,
        rows: request.rows,
        cwd,
        env,
      });

      let session: TerminalSession | null = null;
      const dataSubscription = pty.onData((data) => {
        if (!session) {
          return;
        }
        session.buffer = appendToTerminalBuffer(session.buffer, data);
        this.emitBridgeMessage({
          type: "terminal-data",
          sessionId: session.id,
          data,
        });
      });
      const exitSubscription = pty.onExit(({ exitCode, signal }) => {
        if (!session) {
          return;
        }
        this.destroySession(session, {
          emitExit: true,
          killPty: false,
          code: exitCode,
          signal: signal ?? null,
        });
      });

      session = {
        id: sessionId,
        pty,
        cwd,
        shell,
        buffer: "",
        conversationId: null,
        dataSubscription,
        exitSubscription,
      };

      this.sessions.set(session.id, session);
      this.setConversationId(session, request.conversationId);
      this.emitAttachEvents(session, request);
    } catch (error) {
      this.sendError(sessionId, normalizeErrorMessage(error), request);
    }
  }

  private attachSession(session: TerminalSession, request: TerminalCreateOrAttachRequest): void {
    this.rebindSessionId(session, request.sessionId);
    this.setConversationId(session, request.conversationId);

    if (request.cols > 0 && request.rows > 0) {
      this.performPtyAction(
        session.id,
        session,
        () => {
          session.pty.resize(request.cols, request.rows);
        },
        request,
      );
    }

    if (request.forceCwdSync && request.cwd) {
      const cwd = this.resolveLocalCwd(request.cwd);
      if (cwd !== session.cwd) {
        this.performPtyAction(
          session.id,
          session,
          () => {
            session.cwd = cwd;
            session.pty.write(`cd ${shellQuote(cwd)}\n`);
          },
          request,
        );
      }
    }

    this.emitAttachEvents(session, request);
  }

  private emitAttachEvents(session: TerminalSession, request: TerminalCreateOrAttachRequest): void {
    const sessionId = request.browserTerminalSessionId ?? session.id;
    if (session.buffer.length > 0) {
      this.emitBridgeMessage(
        withTerminalRoutingTarget(request, {
          type: "terminal-init-log",
          sessionId,
          log: session.buffer,
        }),
      );
    }

    this.emitBridgeMessage(
      withTerminalRoutingTarget(request, {
        type: "terminal-attached",
        sessionId,
        cwd: session.cwd,
        shell: session.shell,
      }),
    );
  }

  private performPtyAction(
    sessionId: string,
    session: TerminalSession,
    action: () => void,
    routingTarget: TerminalRoutingTarget,
  ): void {
    try {
      action();
    } catch (error) {
      this.sendError(sessionId, normalizeErrorMessage(error), routingTarget);
      this.destroySession(session, {
        emitExit: true,
        killPty: true,
        code: null,
        signal: null,
      });
    }
  }

  private destroySession(
    session: TerminalSession,
    options: {
      emitExit: boolean;
      killPty: boolean;
      code: number | null;
      signal: number | null;
    },
  ): void {
    if (this.sessions.get(session.id) !== session) {
      return;
    }

    this.sessions.delete(session.id);
    if (
      session.conversationId &&
      this.sessionsByConversation.get(session.conversationId) === session.id
    ) {
      this.sessionsByConversation.delete(session.conversationId);
    }

    session.dataSubscription.dispose();
    session.exitSubscription.dispose();

    if (options.killPty) {
      try {
        session.pty.kill();
      } catch (error) {
        this.sendError(session.id, normalizeErrorMessage(error), {
          browserSessionId: null,
          browserTerminalSessionId: null,
        });
      }
    }

    if (options.emitExit) {
      this.emitBridgeMessage({
        type: "terminal-exit",
        sessionId: session.id,
        code: options.code,
        signal: options.signal,
      });
    }
  }

  private getExistingSession(request: TerminalCreateOrAttachRequest): TerminalSession | null {
    if (request.sessionId) {
      const existingSession = this.sessions.get(request.sessionId);
      if (existingSession) {
        return existingSession;
      }
    }

    if (request.conversationId) {
      const existingSessionId = this.sessionsByConversation.get(request.conversationId);
      if (existingSessionId) {
        return this.sessions.get(existingSessionId) ?? null;
      }
    }

    return null;
  }

  private rebindSessionId(session: TerminalSession, sessionId: string | null): void {
    if (!sessionId || sessionId === session.id) {
      return;
    }

    this.sessions.delete(session.id);
    session.id = sessionId;
    this.sessions.set(session.id, session);

    if (session.conversationId) {
      this.sessionsByConversation.set(session.conversationId, session.id);
    }
  }

  private setConversationId(session: TerminalSession, conversationId: string | null): void {
    if (session.conversationId) {
      const existingSessionId = this.sessionsByConversation.get(session.conversationId);
      if (existingSessionId === session.id) {
        this.sessionsByConversation.delete(session.conversationId);
      }
    }

    session.conversationId = conversationId;
    if (conversationId) {
      this.sessionsByConversation.set(conversationId, session.id);
    }
  }

  private resolveLocalCwd(requestedCwd: string | null): string {
    if (requestedCwd && existsSync(requestedCwd)) {
      return requestedCwd;
    }

    if (existsSync(this.cwd)) {
      return this.cwd;
    }

    return process.cwd();
  }

  private sendError(
    sessionId: string,
    message: string,
    routingTarget: TerminalRoutingTarget,
  ): void {
    this.emitBridgeMessage(
      withTerminalRoutingTarget(routingTarget, {
        type: "terminal-error",
        sessionId: routingTarget.browserTerminalSessionId ?? sessionId,
        message,
      }),
    );
  }
}

function normalizeCreateOrAttachRequest(
  message: TerminalCreateMessage | TerminalAttachMessage,
): TerminalCreateOrAttachRequest {
  return {
    sessionId: readString(message.sessionId),
    conversationId: readString(message.conversationId),
    cwd: readString(message.cwd),
    cols: readPositiveInteger(message.cols) ?? DEFAULT_TERMINAL_COLS,
    rows: readPositiveInteger(message.rows) ?? DEFAULT_TERMINAL_ROWS,
    forceCwdSync: "forceCwdSync" in message && message.forceCwdSync === true,
    browserSessionId: readString(message._pocodexBrowserSessionId),
    browserTerminalSessionId: readString(message._pocodexBrowserTerminalSessionId),
  };
}

function readTerminalRoutingTarget(
  message:
    | TerminalCreateMessage
    | TerminalAttachMessage
    | TerminalWriteMessage
    | TerminalRunActionMessage
    | TerminalResizeMessage
    | TerminalCloseMessage,
): TerminalRoutingTarget {
  return {
    browserSessionId: readString(message._pocodexBrowserSessionId),
    browserTerminalSessionId: readString(message._pocodexBrowserTerminalSessionId),
  };
}

function withTerminalRoutingTarget(target: TerminalRoutingTarget, message: JsonRecord): JsonRecord {
  if (!target.browserSessionId && !target.browserTerminalSessionId) {
    return message;
  }

  return {
    ...message,
    ...(target.browserSessionId ? { _pocodexBrowserSessionId: target.browserSessionId } : {}),
    ...(target.browserTerminalSessionId
      ? { _pocodexBrowserTerminalSessionId: target.browserTerminalSessionId }
      : {}),
  };
}

function buildRunActionCommand(cwd: string, command: string): string {
  const normalizedCommand = command.replace(/\r\n|\r/g, "\n").trimEnd();
  if (normalizedCommand.length === 0) {
    return `cd ${shellQuote(cwd)}\n`;
  }

  return `cd ${shellQuote(cwd)} && ${normalizedCommand}\n`;
}

function buildTerminalEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: TERMINAL_NAME,
  };
  delete env.TERMINFO;
  delete env.TERMINFO_DIRS;
  return env;
}

function resolveShell(): string {
  const shell = process.env.SHELL?.trim();
  return shell && shell.length > 0 ? shell : DEFAULT_TERMINAL_SHELL;
}

function appendToTerminalBuffer(current: string, next: string): string {
  const combined = `${current}${next}`;
  if (combined.length <= TERMINAL_BUFFER_LIMIT) {
    return combined;
  }

  return combined.slice(-TERMINAL_BUFFER_LIMIT);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function loadNodePty(): Promise<typeof import("node-pty")> {
  nodePtyModulePromise ??= import("node-pty");
  try {
    return await nodePtyModulePromise;
  } catch (error) {
    nodePtyModulePromise = null;
    if (shouldAttemptNodePtyRebuild(error) && !nodePtyRebuildAttempted) {
      nodePtyRebuildAttempted = true;
      const rebuilt = await tryRebuildNodePty();
      if (rebuilt) {
        nodePtyModulePromise = import("node-pty");
        return await nodePtyModulePromise;
      }
    }

    if (shouldAttemptNodePtyRebuild(error)) {
      throw new Error(buildNodePtyLoadErrorMessage(error, nodePtyRebuildAttempted));
    }

    throw error;
  }
}

function ensureNodePtySpawnHelperIsExecutable(): void {
  if (nodePtySpawnHelperPrepared || process.platform === "win32") {
    return;
  }

  const require = createRequire(import.meta.url);
  const nodePtyRoot = dirname(dirname(require.resolve("node-pty")));
  const helperCandidates = [
    join(nodePtyRoot, "build", "Release", "spawn-helper"),
    join(nodePtyRoot, "build", "Debug", "spawn-helper"),
    join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];

  for (const helperPath of helperCandidates) {
    if (!existsSync(helperPath)) {
      continue;
    }

    const currentMode = statSync(helperPath).mode;
    if ((currentMode & 0o111) === 0) {
      chmodSync(helperPath, currentMode | 0o755);
    }
    break;
  }

  nodePtySpawnHelperPrepared = true;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldAttemptNodePtyRebuild(error: unknown): boolean {
  const message = normalizeErrorMessage(error);
  return message.includes("pty.node") || message.includes("Failed to load native module");
}

async function tryRebuildNodePty(): Promise<boolean> {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) {
    return false;
  }

  for (const command of [
    { cmd: "pnpm", args: ["rebuild", "node-pty"] },
    { cmd: "npm", args: ["rebuild", "node-pty"] },
    { cmd: "yarn", args: ["rebuild", "node-pty"] },
  ]) {
    try {
      await execFileAsync(command.cmd, command.args, packageRoot);
      return true;
    } catch (error) {
      if (isCommandNotFoundError(error)) {
        continue;
      }
    }
  }

  return false;
}

function execFileAsync(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 120_000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isCommandNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function findPackageRoot(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function buildNodePtyLoadErrorMessage(error: unknown, rebuildAttempted: boolean): string {
  const baseMessage = normalizeErrorMessage(error);
  const rebuildHint = rebuildAttempted
    ? "Automatic rebuild failed."
    : "The node-pty native module is missing.";
  const instructions =
    "Run `pnpm rebuild node-pty` in the Pocodex install directory (or reinstall) and restart.";
  return `${rebuildHint} ${instructions}\n${baseMessage}`;
}
