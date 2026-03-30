import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getServeUrls: vi.fn(),
  loadCodexBundle: vi.fn(),
  serverInstances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    getAddress: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    notifyStylesheetReload: ReturnType<typeof vi.fn>;
    options: unknown;
  }>,
}));

vi.mock("../src/lib/app-server-bridge.js", () => ({
  AppServerBridge: {
    connect: runtimeMocks.connect,
  },
}));

vi.mock("../src/lib/codex-bundle.js", () => ({
  loadCodexBundle: runtimeMocks.loadCodexBundle,
}));

vi.mock("../src/lib/serve-url.js", () => ({
  getServeUrls: runtimeMocks.getServeUrls,
}));

vi.mock("../src/lib/server.js", () => ({
  PocodexServer: class {
    close = vi.fn(async () => {});
    getAddress = vi.fn(() => ({
      address: "127.0.0.1",
      family: "IPv4",
      port: 4321,
    }));
    listen = vi.fn(async () => {});
    notifyStylesheetReload = vi.fn();

    constructor(public readonly options: unknown) {
      runtimeMocks.serverInstances.push(this);
    }
  },
}));

import { createPocodexRuntime } from "../src/index.js";

class TestRelay extends EventEmitter {
  close = vi.fn(async () => {});
  forwardBridgeMessage = vi.fn(async () => {});
  sendWorkerMessage = vi.fn(async () => {});
  subscribeWorker = vi.fn(async () => {});
  unsubscribeWorker = vi.fn(async () => {});
}

describe("createPocodexRuntime", () => {
  afterEach(() => {
    runtimeMocks.connect.mockReset();
    runtimeMocks.getServeUrls.mockReset();
    runtimeMocks.loadCodexBundle.mockReset();
    runtimeMocks.serverInstances.length = 0;
  });

  it("starts successfully and exposes a running snapshot", async () => {
    const relay = new TestRelay();
    runtimeMocks.connect.mockResolvedValue(relay);
    runtimeMocks.loadCodexBundle.mockResolvedValue(createBundle("1.2.3"));
    runtimeMocks.getServeUrls.mockReturnValue({
      localOpenUrl: "http://127.0.0.1:4321/?token=secret",
      localUrl: "http://127.0.0.1:4321/",
      networkOpenUrl: "http://192.168.1.24:4321/?token=secret",
      networkUrl: "http://192.168.1.24:4321/",
    });

    const runtime = createPocodexRuntime({
      appPath: "/Applications/Codex.app",
      cwd: "/Users/davejeffery/code/pocodex",
      devMode: false,
      listenHost: "0.0.0.0",
      listenPort: 0,
      token: "secret",
    });
    const seenStates: string[] = [];
    runtime.on("snapshot", (snapshot) => {
      seenStates.push(snapshot.state);
    });

    const snapshot = await runtime.start();

    expect(seenStates).toEqual(["starting", "running"]);
    expect(snapshot).toEqual({
      appPath: "/Applications/Codex.app",
      codexVersion: "1.2.3",
      lastError: null,
      listenHost: "0.0.0.0",
      listenPort: 4321,
      localOpenUrl: "http://127.0.0.1:4321/?token=secret",
      localUrl: "http://127.0.0.1:4321/",
      networkOpenUrl: "http://192.168.1.24:4321/?token=secret",
      networkUrl: "http://192.168.1.24:4321/",
      state: "running",
      tokenConfigured: true,
    });
    expect(runtimeMocks.connect).toHaveBeenCalledWith({
      appPath: "/Applications/Codex.app",
      cwd: "/Users/davejeffery/code/pocodex",
    });
    expect(runtimeMocks.serverInstances).toHaveLength(1);
    expect(runtimeMocks.serverInstances[0]?.listen).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly and clears the active URLs", async () => {
    const relay = new TestRelay();
    runtimeMocks.connect.mockResolvedValue(relay);
    runtimeMocks.loadCodexBundle.mockResolvedValue(createBundle("1.2.3"));
    runtimeMocks.getServeUrls.mockReturnValue({
      localOpenUrl: "http://127.0.0.1:4321/",
      localUrl: "http://127.0.0.1:4321/",
      networkOpenUrl: null,
      networkUrl: null,
    });

    const runtime = createPocodexRuntime({
      appPath: "/Applications/Codex.app",
      cwd: "/tmp",
      devMode: false,
      listenHost: "127.0.0.1",
      listenPort: 0,
      token: "",
    });

    await runtime.start();
    await runtime.stop();

    expect(runtimeMocks.serverInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(relay.close).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toEqual({
      appPath: "/Applications/Codex.app",
      codexVersion: "1.2.3",
      lastError: null,
      listenHost: "127.0.0.1",
      listenPort: 0,
      localOpenUrl: null,
      localUrl: null,
      networkOpenUrl: null,
      networkUrl: null,
      state: "stopped",
      tokenConfigured: false,
    });
  });

  it("restarts with updated options and emits a fresh running snapshot", async () => {
    const firstRelay = new TestRelay();
    const secondRelay = new TestRelay();
    runtimeMocks.connect.mockResolvedValueOnce(firstRelay).mockResolvedValueOnce(secondRelay);
    runtimeMocks.loadCodexBundle
      .mockResolvedValueOnce(createBundle("1.2.3"))
      .mockResolvedValueOnce(createBundle("2.0.0", "/Applications/Codex Beta.app"));
    runtimeMocks.getServeUrls
      .mockReturnValueOnce({
        localOpenUrl: "http://127.0.0.1:4000/",
        localUrl: "http://127.0.0.1:4000/",
        networkOpenUrl: null,
        networkUrl: null,
      })
      .mockReturnValueOnce({
        localOpenUrl: "http://127.0.0.1:4321/?token=secret",
        localUrl: "http://127.0.0.1:4321/",
        networkOpenUrl: "http://192.168.1.24:4321/?token=secret",
        networkUrl: "http://192.168.1.24:4321/",
      });

    const runtime = createPocodexRuntime({
      appPath: "/Applications/Codex.app",
      cwd: "/tmp",
      devMode: false,
      listenHost: "127.0.0.1",
      listenPort: 8787,
      token: "",
    });

    await runtime.start();
    const nextSnapshot = await runtime.restart({
      appPath: "/Applications/Codex Beta.app",
      listenHost: "0.0.0.0",
      listenPort: 0,
      token: "secret",
    });

    expect(runtimeMocks.serverInstances).toHaveLength(2);
    expect(runtimeMocks.serverInstances[0]?.close).toHaveBeenCalledTimes(1);
    expect(firstRelay.close).toHaveBeenCalledTimes(1);
    expect(nextSnapshot).toEqual({
      appPath: "/Applications/Codex Beta.app",
      codexVersion: "2.0.0",
      lastError: null,
      listenHost: "0.0.0.0",
      listenPort: 4321,
      localOpenUrl: "http://127.0.0.1:4321/?token=secret",
      localUrl: "http://127.0.0.1:4321/",
      networkOpenUrl: "http://192.168.1.24:4321/?token=secret",
      networkUrl: "http://192.168.1.24:4321/",
      state: "running",
      tokenConfigured: true,
    });
  });

  it("captures startup failures as an error snapshot", async () => {
    runtimeMocks.loadCodexBundle.mockRejectedValue(new Error("Codex bundle missing"));
    const runtime = createPocodexRuntime({
      appPath: "/Applications/Codex.app",
      cwd: "/tmp",
      devMode: false,
      listenHost: "127.0.0.1",
      listenPort: 0,
      token: "",
    });
    const seenErrors: string[] = [];
    runtime.on("error", (error) => {
      seenErrors.push(error.message);
    });

    await expect(runtime.start()).rejects.toThrow("Codex bundle missing");

    expect(seenErrors).toEqual(["Codex bundle missing"]);
    expect(runtime.getSnapshot()).toEqual({
      appPath: "/Applications/Codex.app",
      codexVersion: null,
      lastError: "Codex bundle missing",
      listenHost: "127.0.0.1",
      listenPort: 0,
      localOpenUrl: null,
      localUrl: null,
      networkOpenUrl: null,
      networkUrl: null,
      state: "error",
      tokenConfigured: false,
    });
  });
});

function createBundle(version: string, appPath = "/Applications/Codex.app") {
  return {
    appPath,
    buildFlavor: "prod",
    buildNumber: "123",
    readIndexHtml: vi.fn(async () => "<!doctype html><html><body></body></html>"),
    version,
    webviewRoot: "/tmp/pocodex-webview",
  };
}
