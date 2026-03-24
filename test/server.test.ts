import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { PocodexServer } from "../src/lib/server.js";

class StubRelay extends EventEmitter {
  forwardedMessages: unknown[] = [];
  subscribedWorkers: string[] = [];
  unsubscribedWorkers: string[] = [];
  workerMessages: Array<{ workerName: string; message: unknown }> = [];
  ipcPayloads: unknown[] = [];

  async forwardBridgeMessage(message: unknown): Promise<void> {
    this.forwardedMessages.push(message);
  }

  async subscribeWorker(workerName: string): Promise<void> {
    this.subscribedWorkers.push(workerName);
  }

  async unsubscribeWorker(workerName: string): Promise<void> {
    this.unsubscribedWorkers.push(workerName);
  }

  async sendWorkerMessage(workerName: string, message: unknown): Promise<void> {
    this.workerMessages.push({ workerName, message });
  }

  async handleIpcRequest(payload: unknown): Promise<unknown> {
    this.ipcPayloads.push(payload);
    return {
      requestId:
        typeof payload === "object" &&
        payload !== null &&
        "requestId" in payload &&
        typeof payload.requestId === "string"
          ? payload.requestId
          : "",
      type: "response",
      resultType: "success",
      result: {
        ok: true,
      },
    };
  }
}

describe("PocodexServer", () => {
  const servers: PocodexServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        await server.close();
      }),
    );
  });

  it("rewrites browser request IDs and strips them on the way back", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    const second = await connect(url, "secret");
    const firstMessage = nextMessage(first);

    first.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "fetch",
          requestId: "request-1",
          url: "vscode://codex/thread/list",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 1);

    expect(relay.forwardedMessages[0]).toEqual({
      type: "fetch",
      requestId: expect.stringMatching(/^pocodex:[^:]+:request-1$/),
      url: "vscode://codex/thread/list",
    });

    const prefixedRequestId = (relay.forwardedMessages[0] as { requestId: string }).requestId;
    relay.emit("bridge_message", {
      type: "fetch-response",
      requestId: prefixedRequestId,
      status: 200,
    });

    await expect(firstMessage).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "fetch-response",
        requestId: "request-1",
        status: 200,
      },
    });

    await expectNoMessage(second);

    first.close();
    second.close();
  });

  it("keeps the first browser session connected when a second client connects", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    const second = await connect(url, "secret");

    await expectNoMessage(first);

    const next = nextMessage(first);
    first.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "fetch",
          requestId: "request-1",
          url: "vscode://codex/thread/list",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 1);
    const prefixedRequestId = (relay.forwardedMessages[0] as { requestId: string }).requestId;
    relay.emit("bridge_message", {
      type: "fetch-response",
      requestId: prefixedRequestId,
      status: 200,
    });

    await expect(next).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "fetch-response",
        requestId: "request-1",
        status: 200,
      },
    });

    first.close();
    second.close();
  });

  it("serves the Pocodex stylesheet from its dedicated route", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const response = await fetch(`${url}/pocodex.css`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    await expect(response.text()).resolves.toContain("[data-pocodex-toast]");
  });

  it("serves a web manifest for installable clients", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const response = await fetch(`${url}/manifest.webmanifest`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    await expect(response.json()).resolves.toEqual({
      id: "/",
      name: "Pocodex",
      short_name: "Pocodex",
      start_url: "./",
      display: "standalone",
    });
  });

  it("serves a service worker script for shell caching", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const response = await fetch(`${url}/service-worker.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    await expect(response.text()).resolves.toContain("pocodex-shell:test");
  });

  it("validates session tokens before websocket attach", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const okResponse = await fetch(`${url}/session-check?token=secret`);
    const unauthorizedResponse = await fetch(`${url}/session-check?token=wrong`);

    expect(okResponse.status).toBe(200);
    await expect(okResponse.json()).resolves.toEqual({ ok: true });

    expect(unauthorizedResponse.status).toBe(401);
    await expect(unauthorizedResponse.json()).resolves.toEqual({ ok: false });
  });

  it("allows unauthenticated session checks and websocket attach when no token is configured", async () => {
    const { server, url } = await createTestServer("");
    servers.push(server);

    const okResponse = await fetch(`${url}/session-check`);
    const tokenResponse = await fetch(`${url}/session-check?token=anything`);

    expect(okResponse.status).toBe(200);
    await expect(okResponse.json()).resolves.toEqual({ ok: true });

    expect(tokenResponse.status).toBe(200);
    await expect(tokenResponse.json()).resolves.toEqual({ ok: true });

    const socket = await connect(url);
    socket.close();
  });

  it("broadcasts untargeted relay notifications to all connected browser sessions", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    const second = await connect(url, "secret");
    const firstNext = nextMessage(first);
    const secondNext = nextMessage(second);

    relay.emit("bridge_message", {
      type: "pinned-threads-updated",
    });

    await expect(firstNext).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "pinned-threads-updated",
      },
    });
    await expect(secondNext).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "pinned-threads-updated",
      },
    });

    first.close();
    second.close();
  });

  it("broadcasts css reload notifications to all connected browser sessions", async () => {
    const { server, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    const second = await connect(url, "secret");
    const firstNext = nextMessage(first);
    const secondNext = nextMessage(second);

    server.notifyStylesheetReload("123");

    await expect(firstNext).resolves.toEqual({
      type: "css_reload",
      href: "/pocodex.css?v=123",
    });
    await expect(secondNext).resolves.toEqual({
      type: "css_reload",
      href: "/pocodex.css?v=123",
    });

    first.close();
    second.close();
  });

  it("emits heartbeat envelopes to connected browser sessions", async () => {
    const { server, url } = await createTestServer("secret", {
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
    });
    servers.push(server);

    const socket = await connect(url, "secret");

    await expect(nextMessage(socket)).resolves.toEqual({
      type: "heartbeat",
      sentAt: expect.any(Number),
    });

    socket.close();
  });

  it("closes stale websocket sessions after missed heartbeat acknowledgements", async () => {
    const { server, url } = await createTestServer("secret", {
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 60,
    });
    servers.push(server);

    const socket = await connect(url, "secret");

    await expect(
      new Promise<number>((resolve, reject) => {
        socket.once("close", (code) => resolve(code));
        socket.once("error", reject);
      }),
    ).resolves.toBe(4000);
  });

  it("refcounts worker subscriptions across browser sessions", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    const second = await connect(url, "secret");

    first.send(JSON.stringify({ type: "worker_subscribe", workerName: "git" }));
    second.send(JSON.stringify({ type: "worker_subscribe", workerName: "git" }));

    await waitForCondition(() => relay.subscribedWorkers.length === 1);
    expect(relay.subscribedWorkers).toEqual(["git"]);

    first.send(JSON.stringify({ type: "worker_unsubscribe", workerName: "git" }));
    await waitForCondition(() => relay.subscribedWorkers.length === 1);
    expect(relay.unsubscribedWorkers).toEqual([]);

    second.close();
    await waitForCondition(() => relay.unsubscribedWorkers.length === 1);
    expect(relay.unsubscribedWorkers).toEqual(["git"]);

    first.close();
  });

  it("routes terminal output to all observers while enforcing a single controller", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const first = await connect(url, "secret");
    const second = await connect(url, "secret");

    first.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "terminal-create",
          sessionId: "term-a",
          conversationId: "conv-1",
          cwd: "/tmp",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 1);
    expect(relay.forwardedMessages[0]).toEqual(
      expect.objectContaining({
        type: "terminal-create",
        sessionId: "term-a",
        _pocodexBrowserTerminalSessionId: "term-a",
      }),
    );

    const firstBrowserSessionId = (
      relay.forwardedMessages[0] as { _pocodexBrowserSessionId: string }
    )._pocodexBrowserSessionId;

    const firstAttached = nextMessage(first);
    relay.emit("bridge_message", {
      type: "terminal-attached",
      sessionId: "term-a",
      cwd: "/tmp",
      shell: "/bin/zsh",
      _pocodexBrowserSessionId: firstBrowserSessionId,
      _pocodexBrowserTerminalSessionId: "term-a",
    });

    await expect(firstAttached).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "terminal-attached",
        sessionId: "term-a",
        cwd: "/tmp",
        shell: "/bin/zsh",
      },
    });

    second.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "terminal-attach",
          sessionId: "term-b",
          conversationId: "conv-1",
          cwd: "/tmp",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 2);
    expect(relay.forwardedMessages[1]).toEqual(
      expect.objectContaining({
        type: "terminal-attach",
        sessionId: "term-a",
        _pocodexBrowserTerminalSessionId: "term-b",
      }),
    );

    const secondBrowserSessionId = (
      relay.forwardedMessages[1] as { _pocodexBrowserSessionId: string }
    )._pocodexBrowserSessionId;

    const secondInitLog = nextMessage(second);
    relay.emit("bridge_message", {
      type: "terminal-init-log",
      sessionId: "term-b",
      log: "prompt> ",
      _pocodexBrowserSessionId: secondBrowserSessionId,
      _pocodexBrowserTerminalSessionId: "term-b",
    });
    await expect(secondInitLog).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "terminal-init-log",
        sessionId: "term-b",
        log: "prompt> ",
      },
    });

    const secondAttached = nextMessage(second);
    relay.emit("bridge_message", {
      type: "terminal-attached",
      sessionId: "term-b",
      cwd: "/tmp",
      shell: "/bin/zsh",
      _pocodexBrowserSessionId: secondBrowserSessionId,
      _pocodexBrowserTerminalSessionId: "term-b",
    });
    await expect(secondAttached).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "terminal-attached",
        sessionId: "term-b",
        cwd: "/tmp",
        shell: "/bin/zsh",
      },
    });

    const firstData = nextMessage(first);
    const secondData = nextMessage(second);
    relay.emit("bridge_message", {
      type: "terminal-data",
      sessionId: "term-a",
      data: "pwd\r\n",
    });

    await expect(firstData).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "terminal-data",
        sessionId: "term-a",
        data: "pwd\r\n",
      },
    });
    await expect(secondData).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "terminal-data",
        sessionId: "term-b",
        data: "pwd\r\n",
      },
    });

    const observerRejected = nextMessage(second);
    second.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "terminal-write",
          sessionId: "term-b",
          data: "whoami\n",
        },
      }),
    );

    await expect(observerRejected).resolves.toEqual({
      type: "bridge_message",
      message: {
        type: "terminal-error",
        sessionId: "term-b",
        message: "Another browser controls this terminal.",
      },
    });
    expect(relay.forwardedMessages).toHaveLength(2);

    first.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "terminal-write",
          sessionId: "term-a",
          data: "whoami\n",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 3);
    expect(relay.forwardedMessages[2]).toEqual(
      expect.objectContaining({
        type: "terminal-write",
        sessionId: "term-a",
        data: "whoami\n",
      }),
    );

    const firstClosed = new Promise<void>((resolve) => {
      first.once("close", () => resolve());
    });
    first.close();
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 20));

    second.send(
      JSON.stringify({
        type: "bridge_message",
        message: {
          type: "terminal-write",
          sessionId: "term-b",
          data: "whoami\n",
        },
      }),
    );

    await waitForCondition(() => relay.forwardedMessages.length === 4);
    expect(relay.forwardedMessages[3]).toEqual(
      expect.objectContaining({
        type: "terminal-write",
        sessionId: "term-a",
        data: "whoami\n",
      }),
    );

    second.close();
  });

  it("routes vscode ipc requests through the relay", async () => {
    const { server, relay, url } = await createTestServer();
    servers.push(server);

    const response = await fetch(`${url}/ipc-request`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-1",
        method: "thread-follower-start-turn",
        params: {
          conversationId: "thr_123",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(relay.ipcPayloads).toEqual([
      {
        requestId: "req-1",
        method: "thread-follower-start-turn",
        params: {
          conversationId: "thr_123",
        },
      },
    ]);
    await expect(response.json()).resolves.toEqual({
      requestId: "req-1",
      type: "response",
      resultType: "success",
      result: {
        ok: true,
      },
    });
  });
});

async function createTestServer(): Promise<{
  relay: StubRelay;
  server: PocodexServer;
  url: string;
}>;
async function createTestServer(
  token = "secret",
  options: {
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
  } = {},
): Promise<{
  relay: StubRelay;
  server: PocodexServer;
  url: string;
}> {
  const relay = new StubRelay();
  const webviewRoot = await mkdtemp(join(tmpdir(), "pocodex-webview-"));
  await writeFile(join(webviewRoot, "index.html"), "<!doctype html><html><body></body></html>");

  const server = new PocodexServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    token,
    relay: relay as never,
    webviewRoot,
    readPocodexStylesheet: async () => "#pocodex-toast-host [data-pocodex-toast] { color: red; }",
    renderIndexHtml: async () => "<!doctype html><html><body></body></html>",
    renderWebManifest: async () =>
      JSON.stringify({
        id: "/",
        name: "Pocodex",
        short_name: "Pocodex",
        start_url: "./",
        display: "standalone",
      }),
    renderServiceWorkerScript: async () => "const CACHE_NAME = 'pocodex-shell:test';",
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  });

  await server.listen();
  const address = server.getAddress();

  return {
    relay,
    server,
    url: `http://${address.address}:${address.port}`,
  };
}

async function connect(baseUrl: string, token?: string): Promise<WebSocket> {
  const url = new URL(`${baseUrl.replace(/^http/, "ws")}/session`);
  if (token) {
    url.searchParams.set("token", token);
  }
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  const data = await new Promise<string>((resolve, reject) => {
    socket.once("message", (buffer) => resolve(String(buffer)));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("socket closed before a message arrived")));
  });
  return JSON.parse(data);
}

async function expectNoMessage(socket: WebSocket, timeoutMs = 100): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const onMessage = (buffer: Buffer) => {
      cleanup();
      reject(new Error(`Unexpected message: ${String(buffer)}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
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
