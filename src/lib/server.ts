import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import mimeTypes from "mime-types";
import { WebSocket, WebSocketServer } from "ws";

import { debugLog } from "./debug.js";
import { getUnsupportedBridgeNotice } from "./native-policy.js";
import type {
  JsonRecord,
  BrowserToServerEnvelope,
  PocodexServerOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { routeHostMessage, rewriteRequestIdsForHost } from "./request-id.js";

interface BrowserSession {
  id: string;
  socket: WebSocket;
  subscribedWorkers: Set<string>;
  isFocused: boolean;
  terminalSessionIdsByLocalSessionId: Map<string, string>;
  lastHeartbeatAckAt: number;
}

interface TerminalSessionRoute {
  id: string;
  conversationId: string | null;
  ownerBrowserSessionId: string | null;
  participantOrder: string[];
  localSessionIdsByBrowserSessionId: Map<string, string>;
}

const TERMINAL_CONTROL_MESSAGE_TYPES = new Set([
  "terminal-write",
  "terminal-run-action",
  "terminal-resize",
  "terminal-close",
]);
const TERMINAL_ATTACH_MESSAGE_TYPES = new Set(["terminal-create", "terminal-attach"]);
const TERMINAL_STREAM_MESSAGE_TYPES = new Set(["terminal-data", "terminal-error", "terminal-exit"]);
const TERMINAL_TARGET_BROWSER_SESSION_ID_KEY = "_pocodexBrowserSessionId";
const TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY = "_pocodexBrowserTerminalSessionId";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export class PocodexServer {
  private readonly httpServer: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly pendingBySocket = new WeakMap<WebSocket, Promise<void>>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly workerSubscriberCounts = new Map<string, number>();
  private readonly terminalSessionRoutes = new Map<string, TerminalSessionRoute>();
  private readonly terminalSessionIdsByConversation = new Map<string, string>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private indexHtmlPromise?: Promise<string>;
  private serviceWorkerScriptPromise?: Promise<string>;
  private webManifestPromise?: Promise<string>;

  constructor(private readonly options: PocodexServerOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = Math.max(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      this.heartbeatIntervalMs + 1,
    );
    this.httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.wsServer = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.wsServer.on("connection", (socket) => {
      this.handleConnection(socket);
    });

    this.options.relay.on("bridge_message", (message) => {
      this.handleRelayBridgeMessage(message);
    });
    this.options.relay.on("worker_message", (workerName, message) => {
      this.handleRelayWorkerMessage(workerName, message);
    });
    this.options.relay.on("error", (error) => {
      this.broadcast({
        type: "error",
        message: error.message,
      });
    });

    this.heartbeatTimer = setInterval(() => {
      this.handleHeartbeatTick();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.listenPort, this.options.listenHost, () => {
        this.httpServer.off("error", reject);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer);
    for (const session of this.sessions.values()) {
      session.socket.close(1000, "shutdown");
    }
    this.sessions.clear();
    this.workerSubscriberCounts.clear();
    this.terminalSessionRoutes.clear();
    this.terminalSessionIdsByConversation.clear();

    for (const client of this.wsServer.clients) {
      client.terminate();
    }

    await new Promise<void>((resolvePromise) => {
      this.wsServer.close(() => resolvePromise());
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.httpServer.closeIdleConnections?.();
      this.httpServer.closeAllConnections?.();
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }

  getAddress(): AddressInfo {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Pocodex server is not listening on a TCP address");
    }
    return address;
  }

  notifyStylesheetReload(versionTag: string): void {
    this.broadcast({
      type: "css_reload",
      href: `/pocodex.css?v=${encodeURIComponent(versionTag)}`,
    });
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${this.options.listenHost}:${this.options.listenPort}`,
    );

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await this.getIndexHtml());
      return;
    }

    if (url.pathname === "/session-check") {
      const authorized = this.isAuthorized(url.searchParams.get("token"));
      response.statusCode = authorized ? 200 : 401;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: authorized }));
      return;
    }

    if (url.pathname === "/pocodex.css") {
      try {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/css; charset=utf-8");
        response.end(await this.options.readPocodexStylesheet());
      } catch {
        response.statusCode = 500;
        response.end("Unable to load Pocodex stylesheet");
      }
      return;
    }

    if (url.pathname === "/manifest.webmanifest") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
      response.end(await this.getWebManifest());
      return;
    }

    if (url.pathname === "/service-worker.js") {
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.setHeader("Service-Worker-Allowed", "/");
      response.end(await this.getServiceWorkerScript());
      return;
    }

    if (url.pathname === "/healthz") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/ipc-request") {
      await this.handleIpcRequest(request, response);
      return;
    }

    const relativePath = url.pathname.replace(/^\/+/, "");
    const absolutePath = resolve(this.options.webviewRoot, relativePath);
    if (!absolutePath.startsWith(`${this.options.webviewRoot}${sep}`)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    try {
      const fileBuffer = await readFile(absolutePath);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader(
        "Content-Type",
        mimeTypes.lookup(absolutePath) || "application/octet-stream",
      );
      response.end(fileBuffer);
    } catch {
      if (shouldServeSpaShell(request.method, url.pathname)) {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await this.getIndexHtml());
        return;
      }
      response.statusCode = 404;
      response.end("Not found");
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(
      request.url ?? "/",
      `http://${this.options.listenHost}:${this.options.listenPort}`,
    );
    if (url.pathname !== "/session") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      this.wsServer.emit("connection", upgradedSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    const session: BrowserSession = {
      id: randomUUID(),
      socket,
      subscribedWorkers: new Set(),
      isFocused: true,
      terminalSessionIdsByLocalSessionId: new Map(),
      lastHeartbeatAckAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    debugLog("server", "browser connected", { sessionId: session.id });

    socket.on("message", (data) => {
      const previous = this.pendingBySocket.get(socket) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleSocketMessage(session, String(data)))
        .catch((error) => {
          this.send(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      this.pendingBySocket.set(socket, next);
    });

    socket.on("close", () => {
      debugLog("server", "browser disconnected", { sessionId: session.id });
      if (this.sessions.get(session.id) !== session) {
        return;
      }
      this.cleanupSession(session);
    });
  }

  private isAuthorized(requestToken: string | null): boolean {
    return this.options.token.length === 0 || requestToken === this.options.token;
  }

  private async handleSocketMessage(session: BrowserSession, raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as BrowserToServerEnvelope;
    session.lastHeartbeatAckAt = Date.now();
    debugLog("server", "browser message", envelope);

    if (this.sessions.get(session.id) !== session) {
      this.send(session.socket, {
        type: "session_revoked",
        reason: "This Pocodex session is no longer active.",
      });
      session.socket.close(4001, "inactive");
      return;
    }

    switch (envelope.type) {
      case "bridge_message":
        await this.handleBridgeEnvelope(session, envelope.message);
        break;
      case "worker_subscribe":
        if (!session.subscribedWorkers.has(envelope.workerName)) {
          session.subscribedWorkers.add(envelope.workerName);
          await this.incrementWorkerSubscribers(envelope.workerName);
        }
        break;
      case "worker_unsubscribe":
        if (session.subscribedWorkers.delete(envelope.workerName)) {
          await this.decrementWorkerSubscribers(envelope.workerName);
        }
        break;
      case "worker_message":
        void this.options.relay
          .sendWorkerMessage(envelope.workerName, envelope.message)
          .catch((error) => {
            this.send(session.socket, {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        break;
      case "focus_state":
        session.isFocused = envelope.isFocused;
        this.send(session.socket, {
          type: "bridge_message",
          message: {
            type: "electron-window-focus-changed",
            isFocused: envelope.isFocused,
          },
        });
        break;
      case "heartbeat_ack":
        break;
      default:
        this.send(session.socket, {
          type: "error",
          message: `Unknown Pocodex browser message ${(envelope as { type: string }).type}`,
        });
    }
  }

  private async handleBridgeEnvelope(session: BrowserSession, message: unknown): Promise<void> {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type?: unknown }).type === "electron-window-focus-request"
    ) {
      this.send(session.socket, {
        type: "bridge_message",
        message: {
          type: "electron-window-focus-changed",
          isFocused: session.isFocused,
        },
      });
      return;
    }

    if (isTerminalBridgeMessage(message)) {
      await this.handleTerminalBridgeEnvelope(session, message);
      return;
    }

    const blockedNotice = getUnsupportedBridgeNotice(message);
    if (blockedNotice) {
      debugLog("server", "blocked browser bridge message", {
        message,
        blockedNotice,
      });
      // this.send(session.socket, {
      //   type: "client_notice",
      //   message: blockedNotice,
      // });
      return;
    }

    const rewrittenMessage = rewriteRequestIdsForHost(session.id, message);
    debugLog("server", "forwarding bridge message to relay", rewrittenMessage);
    if (isAsyncBridgeRelayMessage(rewrittenMessage)) {
      void this.options.relay.forwardBridgeMessage(rewrittenMessage).catch((error) => {
        this.send(session.socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    await this.options.relay.forwardBridgeMessage(rewrittenMessage);
  }

  private async handleIpcRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawBody = await readRequestBody(request);
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: "",
          type: "response",
          resultType: "error",
          error: "Invalid JSON body.",
        }),
      );
      return;
    }

    if (!this.options.relay.handleIpcRequest) {
      response.statusCode = 501;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: extractRequestId(payload),
          type: "response",
          resultType: "error",
          error: "IPC requests are not supported by the active host bridge.",
        }),
      );
      return;
    }

    try {
      const result = await this.options.relay.handleIpcRequest(payload);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          requestId: extractRequestId(payload),
          type: "response",
          resultType: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private handleRelayBridgeMessage(message: unknown): void {
    debugLog("server", "relay bridge message", message);
    const routed = routeHostMessage(message);
    if (!routed.deliver || !routed.message) {
      debugLog("server", "dropped relay bridge message", routed);
      return;
    }

    const bridgeMessage = routed.message;
    if (routed.sessionId) {
      this.sendBridgeMessageToSession(routed.sessionId, bridgeMessage);
      return;
    }

    if (!isJsonRecord(bridgeMessage) || typeof bridgeMessage.type !== "string") {
      this.broadcast({
        type: "bridge_message",
        message: bridgeMessage,
      });
      return;
    }

    const typedBridgeMessage = bridgeMessage as JsonRecord & { type: string };

    if (this.handleTargetedTerminalRelayMessage(typedBridgeMessage)) {
      return;
    }

    if (this.handleTerminalStreamRelayMessage(typedBridgeMessage)) {
      return;
    }

    this.broadcast({
      type: "bridge_message",
      message: stripInternalBridgeFields(typedBridgeMessage),
    });
  }

  private handleRelayWorkerMessage(workerName: string, message: unknown): void {
    debugLog("server", "relay worker message", { workerName, message });
    for (const session of this.sessions.values()) {
      if (!session.subscribedWorkers.has(workerName)) {
        continue;
      }
      this.send(session.socket, {
        type: "worker_message",
        workerName,
        message,
      });
    }
  }

  private async handleTerminalBridgeEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    if (TERMINAL_ATTACH_MESSAGE_TYPES.has(message.type)) {
      await this.handleTerminalAttachEnvelope(session, message);
      return;
    }

    if (TERMINAL_CONTROL_MESSAGE_TYPES.has(message.type)) {
      await this.handleTerminalControlEnvelope(session, message);
      return;
    }

    await this.options.relay.forwardBridgeMessage(message);
  }

  private async handleTerminalAttachEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    const requestedLocalSessionId =
      readNonEmptyString(message.sessionId) ?? `pocodex-terminal:${session.id}:${randomUUID()}`;
    const conversationId = readNonEmptyString(message.conversationId);
    const canonicalSessionId =
      session.terminalSessionIdsByLocalSessionId.get(requestedLocalSessionId) ??
      (conversationId ? this.terminalSessionIdsByConversation.get(conversationId) : null) ??
      requestedLocalSessionId;

    const route = this.ensureTerminalRoute(canonicalSessionId, conversationId);
    this.attachBrowserToTerminal(route, session, requestedLocalSessionId);

    await this.options.relay.forwardBridgeMessage({
      ...message,
      sessionId: canonicalSessionId,
      [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: session.id,
      [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: requestedLocalSessionId,
    });
  }

  private async handleTerminalControlEnvelope(
    session: BrowserSession,
    message: JsonRecord & { type: string },
  ): Promise<void> {
    const requestedLocalSessionId = readNonEmptyString(message.sessionId);
    if (!requestedLocalSessionId) {
      return;
    }

    const canonicalSessionId =
      session.terminalSessionIdsByLocalSessionId.get(requestedLocalSessionId);
    if (!canonicalSessionId) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Terminal session is not available.",
      );
      return;
    }

    const route = this.terminalSessionRoutes.get(canonicalSessionId);
    if (!route) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Terminal session is not available.",
      );
      return;
    }

    this.refreshTerminalOwner(route);
    if (route.ownerBrowserSessionId !== session.id) {
      this.sendTerminalError(
        session.id,
        requestedLocalSessionId,
        "Another browser controls this terminal.",
      );
      return;
    }

    await this.options.relay.forwardBridgeMessage({
      ...message,
      sessionId: canonicalSessionId,
      [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: session.id,
      [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: requestedLocalSessionId,
    });
  }

  private ensureTerminalRoute(
    terminalSessionId: string,
    conversationId: string | null,
  ): TerminalSessionRoute {
    let route = this.terminalSessionRoutes.get(terminalSessionId);
    if (!route) {
      route = {
        id: terminalSessionId,
        conversationId,
        ownerBrowserSessionId: null,
        participantOrder: [],
        localSessionIdsByBrowserSessionId: new Map(),
      };
      this.terminalSessionRoutes.set(terminalSessionId, route);
    }

    if (conversationId) {
      route.conversationId = conversationId;
      this.terminalSessionIdsByConversation.set(conversationId, terminalSessionId);
    }

    return route;
  }

  private attachBrowserToTerminal(
    route: TerminalSessionRoute,
    session: BrowserSession,
    localSessionId: string,
  ): void {
    const previousLocalSessionId = route.localSessionIdsByBrowserSessionId.get(session.id);
    if (previousLocalSessionId && previousLocalSessionId !== localSessionId) {
      session.terminalSessionIdsByLocalSessionId.delete(previousLocalSessionId);
    }

    route.localSessionIdsByBrowserSessionId.set(session.id, localSessionId);
    session.terminalSessionIdsByLocalSessionId.set(localSessionId, route.id);
    if (!route.participantOrder.includes(session.id)) {
      route.participantOrder.push(session.id);
    }
    if (!route.ownerBrowserSessionId) {
      route.ownerBrowserSessionId = session.id;
    }
  }

  private handleTargetedTerminalRelayMessage(message: JsonRecord & { type: string }): boolean {
    const targetBrowserSessionId = readNonEmptyString(
      message[TERMINAL_TARGET_BROWSER_SESSION_ID_KEY],
    );
    if (!targetBrowserSessionId) {
      return false;
    }

    this.sendBridgeMessageToSession(targetBrowserSessionId, stripInternalBridgeFields(message));
    return true;
  }

  private handleTerminalStreamRelayMessage(message: JsonRecord & { type: string }): boolean {
    if (!TERMINAL_STREAM_MESSAGE_TYPES.has(message.type)) {
      return false;
    }

    const canonicalSessionId = readNonEmptyString(message.sessionId);
    if (!canonicalSessionId) {
      return false;
    }

    const route = this.terminalSessionRoutes.get(canonicalSessionId);
    if (!route) {
      return false;
    }

    for (const [browserSessionId, localSessionId] of route.localSessionIdsByBrowserSessionId) {
      this.sendBridgeMessageToSession(browserSessionId, {
        ...stripInternalBridgeFields(message),
        sessionId: localSessionId,
      });
    }

    if (message.type === "terminal-exit") {
      this.deleteTerminalRoute(route);
    }

    return true;
  }

  private sendBridgeMessageToSession(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.send(session.socket, {
      type: "bridge_message",
      message,
    });
  }

  private sendTerminalError(
    browserSessionId: string,
    localTerminalSessionId: string,
    message: string,
  ): void {
    this.sendBridgeMessageToSession(browserSessionId, {
      type: "terminal-error",
      sessionId: localTerminalSessionId,
      message,
    });
  }

  private async incrementWorkerSubscribers(workerName: string): Promise<void> {
    const count = this.workerSubscriberCounts.get(workerName) ?? 0;
    if (count === 0) {
      await this.options.relay.subscribeWorker(workerName);
    }
    this.workerSubscriberCounts.set(workerName, count + 1);
  }

  private async decrementWorkerSubscribers(workerName: string): Promise<void> {
    const count = this.workerSubscriberCounts.get(workerName) ?? 0;
    if (count <= 1) {
      this.workerSubscriberCounts.delete(workerName);
      if (count === 1) {
        await this.options.relay.unsubscribeWorker(workerName);
      }
      return;
    }

    this.workerSubscriberCounts.set(workerName, count - 1);
  }

  private cleanupSession(session: BrowserSession): void {
    this.sessions.delete(session.id);
    for (const workerName of session.subscribedWorkers) {
      void this.decrementWorkerSubscribers(workerName);
    }

    for (const [localSessionId, terminalSessionId] of session.terminalSessionIdsByLocalSessionId) {
      session.terminalSessionIdsByLocalSessionId.delete(localSessionId);
      this.detachBrowserFromTerminal(terminalSessionId, session.id);
    }
  }

  private detachBrowserFromTerminal(terminalSessionId: string, browserSessionId: string): void {
    const route = this.terminalSessionRoutes.get(terminalSessionId);
    if (!route) {
      return;
    }

    route.localSessionIdsByBrowserSessionId.delete(browserSessionId);
    route.participantOrder = route.participantOrder.filter(
      (sessionId) => sessionId !== browserSessionId,
    );

    if (route.ownerBrowserSessionId === browserSessionId) {
      route.ownerBrowserSessionId = route.participantOrder[0] ?? null;
    }

    if (route.localSessionIdsByBrowserSessionId.size === 0) {
      this.deleteTerminalRoute(route);
    }
  }

  private deleteTerminalRoute(route: TerminalSessionRoute): void {
    this.terminalSessionRoutes.delete(route.id);
    if (
      route.conversationId &&
      this.terminalSessionIdsByConversation.get(route.conversationId) === route.id
    ) {
      this.terminalSessionIdsByConversation.delete(route.conversationId);
    }

    for (const [browserSessionId, localSessionId] of route.localSessionIdsByBrowserSessionId) {
      const session = this.sessions.get(browserSessionId);
      session?.terminalSessionIdsByLocalSessionId.delete(localSessionId);
    }
  }

  private refreshTerminalOwner(route: TerminalSessionRoute): void {
    if (route.ownerBrowserSessionId && this.isSessionActive(route.ownerBrowserSessionId)) {
      return;
    }

    route.participantOrder = route.participantOrder.filter((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session
        ? route.localSessionIdsByBrowserSessionId.has(session.id) &&
            session.socket.readyState === WebSocket.OPEN
        : false;
    });
    route.ownerBrowserSessionId = route.participantOrder[0] ?? null;
  }

  private isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.socket.readyState === WebSocket.OPEN;
  }

  private broadcast(envelope: ServerToBrowserEnvelope): void {
    for (const session of this.sessions.values()) {
      this.send(session.socket, envelope);
    }
  }

  private handleHeartbeatTick(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastHeartbeatAckAt > this.heartbeatTimeoutMs) {
        debugLog("server", "closing stale browser session", {
          sessionId: session.id,
          idleMs: now - session.lastHeartbeatAckAt,
        });
        session.socket.close(4000, "heartbeat-timeout");
        continue;
      }

      this.send(session.socket, {
        type: "heartbeat",
        sentAt: now,
      });
    }
  }

  private send(socket: WebSocket, envelope: ServerToBrowserEnvelope): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(envelope));
  }

  private getIndexHtml(): Promise<string> {
    if (!this.indexHtmlPromise) {
      this.indexHtmlPromise = this.options.renderIndexHtml();
    }
    return this.indexHtmlPromise;
  }

  private getServiceWorkerScript(): Promise<string> {
    if (!this.serviceWorkerScriptPromise) {
      this.serviceWorkerScriptPromise = this.options.renderServiceWorkerScript();
    }
    return this.serviceWorkerScriptPromise;
  }

  private getWebManifest(): Promise<string> {
    if (!this.webManifestPromise) {
      this.webManifestPromise = this.options.renderWebManifest();
    }
    return this.webManifestPromise;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractRequestId(payload: unknown): string {
  return typeof payload === "object" &&
    payload !== null &&
    "requestId" in payload &&
    typeof payload.requestId === "string"
    ? payload.requestId
    : "";
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isTerminalBridgeMessage(message: unknown): message is JsonRecord & { type: string } {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    (TERMINAL_ATTACH_MESSAGE_TYPES.has(message.type) ||
      TERMINAL_CONTROL_MESSAGE_TYPES.has(message.type))
  );
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ASYNC_BRIDGE_RELAY_MESSAGE_TYPES = new Set([
  "fetch",
  "cancel-fetch",
  "fetch-stream",
  "cancel-fetch-stream",
  "mcp-request",
  "mcp-response",
  "mcp-notification",
  "log-message",
]);

function isAsyncBridgeRelayMessage(message: unknown): boolean {
  return (
    isJsonRecord(message) &&
    typeof message.type === "string" &&
    ASYNC_BRIDGE_RELAY_MESSAGE_TYPES.has(message.type)
  );
}

function stripInternalBridgeFields(message: JsonRecord): JsonRecord {
  const {
    [TERMINAL_TARGET_BROWSER_SESSION_ID_KEY]: _browserSessionId,
    [TERMINAL_TARGET_BROWSER_TERMINAL_SESSION_ID_KEY]: _browserTerminalSessionId,
    ...rest
  } = message;
  return rest;
}

function shouldServeSpaShell(method: string | undefined, pathname: string): boolean {
  if (method && method !== "GET" && method !== "HEAD") {
    return false;
  }

  const lastPathSegment = pathname.split("/").at(-1) ?? "";
  return !lastPathSegment.includes(".");
}
