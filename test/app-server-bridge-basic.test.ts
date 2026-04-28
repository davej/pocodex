import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  describeAppServerBridge,
  createBridge,
  mockLocalRequestErrors,
  mockPtys,
  tempDirs,
  TEST_WORKSPACE_ROOT,
  getFetchResponse,
  getMcpResponse,
  getMcpJsonResult,
  getFetchJsonBody,
  waitForCondition,
  toSvgDataUrl,
  isBridgeMessage,
} from "./support/app-server-bridge-test-kit.js";

describeAppServerBridge(({ children }) => {
  it("initializes the codex app-server and forwards MCP traffic", async () => {
    const bridge = await createBridge(children);

    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "ready",
    });

    const child = children.at(0);
    expect(child).toBeTruthy();
    const written = child?.writes ?? "";
    expect(written).toContain('"method":"initialize"');
    expect(written).toContain('"method":"initialized"');

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-1",
        method: "thread/list",
        params: {
          limit: 10,
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"id":"req-1"');
    expect(forwarded).toContain('"method":"thread/list"');

    child?.stdout.write(
      `${JSON.stringify({
        id: "req-1",
        result: {
          data: [],
        },
      })}\n`,
    );

    await waitForCondition(() => emittedMessages.length >= 3);

    expect(emittedMessages).toEqual([
      {
        type: "codex-app-server-connection-changed",
        hostId: "local",
        state: "connected",
        transport: "websocket",
      },
      {
        type: "codex-app-server-initialized",
        hostId: "local",
      },
      {
        type: "mcp-response",
        hostId: "local",
        message: {
          id: "req-1",
          result: {
            data: [],
          },
        },
      },
    ]);

    await bridge.close();
  });

  it("passes the resolved codex home through to the spawned app-server", async () => {
    const codexHomePath = join(tmpdir(), "pocodex-custom-codex-home");
    const bridge = await createBridge(children, {
      codexHomePath,
    });
    const { spawn } = await import("node:child_process");

    expect(vi.mocked(spawn).mock.calls.at(0)?.[2]).toMatchObject({
      env: expect.objectContaining({
        CODEX_HOME: codexHomePath,
      }),
    });

    await bridge.close();
  });

  it("rebroadcasts thread stream state changes back to the browser", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "thread-stream-state-changed",
      conversationId: "conv-1",
      patch: {
        items: [],
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "thread-stream-state-changed",
      conversationId: "conv-1",
      patch: {
        items: [],
      },
    });

    await bridge.close();
  });

  it("converts plugin list artwork paths into data URLs", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "pocodex-plugin-root-"));
    tempDirs.push(pluginRoot);
    const assetsPath = join(pluginRoot, "assets");
    await mkdir(assetsPath, { recursive: true });

    const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="#111"/></svg>`;
    const composerSvg = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="#222"/></svg>`;
    const screenshotSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16H0z" fill="#333"/></svg>`;
    const logoPath = join(assetsPath, "logo.svg");
    const composerIconPath = join(assetsPath, "composer.svg");
    const screenshotPath = join(assetsPath, "screenshot.svg");
    await writeFile(logoPath, `${logoSvg}\n`, "utf8");
    await writeFile(composerIconPath, `${composerSvg}\n`, "utf8");
    await writeFile(screenshotPath, `${screenshotSvg}\n`, "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-plugin-list",
        method: "plugin/list",
        params: {},
      },
    });

    const child = children.at(-1);
    child?.stdout.write(
      `${JSON.stringify({
        id: "req-plugin-list",
        result: {
          marketplaces: [
            {
              name: "openai-curated",
              path: join(pluginRoot, "marketplace"),
              plugins: [
                {
                  id: "github",
                  name: "github",
                  authPolicy: "ON_INSTALL",
                  enabled: true,
                  installPolicy: "AVAILABLE",
                  installed: true,
                  source: {
                    type: "local",
                    path: pluginRoot,
                  },
                  interface: {
                    capabilities: ["Interactive"],
                    screenshots: [screenshotPath],
                    displayName: "GitHub",
                    logo: logoPath,
                    composerIcon: composerIconPath,
                  },
                },
              ],
            },
          ],
        },
      })}\n`,
    );

    await waitForCondition(() => Boolean(getMcpResponse(emittedMessages, "req-plugin-list")));

    expect(getMcpJsonResult(emittedMessages, "req-plugin-list")).toEqual({
      marketplaces: [
        {
          name: "openai-curated",
          path: join(pluginRoot, "marketplace"),
          plugins: [
            {
              id: "github",
              name: "github",
              authPolicy: "ON_INSTALL",
              enabled: true,
              installPolicy: "AVAILABLE",
              installed: true,
              source: {
                type: "local",
                path: pluginRoot,
              },
              interface: {
                capabilities: ["Interactive"],
                screenshots: [toSvgDataUrl(`${screenshotSvg}\n`)],
                displayName: "GitHub",
                logo: toSvgDataUrl(`${logoSvg}\n`),
                composerIcon: toSvgDataUrl(`${composerSvg}\n`),
              },
            },
          ],
        },
      ],
    });

    await bridge.close();
  });

  it("converts plugin detail logos and skill icons into data URLs", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "pocodex-plugin-root-"));
    tempDirs.push(pluginRoot);
    const assetsPath = join(pluginRoot, "assets");
    const skillPath = join(pluginRoot, "skills", "demo");
    await mkdir(assetsPath, { recursive: true });
    await mkdir(skillPath, { recursive: true });

    const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="#111"/></svg>`;
    const iconSmallSvg = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" fill="#444"/></svg>`;
    const iconLargeSvg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2h12v12H2z" fill="#555"/></svg>`;
    const logoPath = join(assetsPath, "logo.svg");
    await writeFile(logoPath, `${logoSvg}\n`, "utf8");
    await writeFile(join(skillPath, "icon-small.svg"), `${iconSmallSvg}\n`, "utf8");
    await writeFile(join(skillPath, "icon-large.svg"), `${iconLargeSvg}\n`, "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-plugin-read",
        method: "plugin/read",
        params: {
          marketplacePath: join(pluginRoot, "marketplace"),
          pluginName: "github",
        },
      },
    });

    const child = children.at(-1);
    child?.stdout.write(
      `${JSON.stringify({
        id: "req-plugin-read",
        result: {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: join(pluginRoot, "marketplace"),
            mcpServers: [],
            apps: [],
            summary: {
              id: "github",
              name: "github",
              authPolicy: "ON_INSTALL",
              enabled: true,
              installPolicy: "AVAILABLE",
              installed: true,
              source: {
                type: "local",
                path: pluginRoot,
              },
              interface: {
                capabilities: ["Interactive"],
                screenshots: [],
                displayName: "GitHub",
                logo: logoPath,
              },
            },
            skills: [
              {
                name: "github",
                description: "Triage GitHub work.",
                path: "skills/demo/SKILL.md",
                interface: {
                  iconSmall: "./icon-small.svg",
                  iconLarge: "./icon-large.svg",
                },
              },
            ],
          },
        },
      })}\n`,
    );

    await waitForCondition(() => Boolean(getMcpResponse(emittedMessages, "req-plugin-read")));

    expect(getMcpJsonResult(emittedMessages, "req-plugin-read")).toEqual({
      plugin: {
        marketplaceName: "openai-curated",
        marketplacePath: join(pluginRoot, "marketplace"),
        mcpServers: [],
        apps: [],
        summary: {
          id: "github",
          name: "github",
          authPolicy: "ON_INSTALL",
          enabled: true,
          installPolicy: "AVAILABLE",
          installed: true,
          source: {
            type: "local",
            path: pluginRoot,
          },
          interface: {
            capabilities: ["Interactive"],
            screenshots: [],
            displayName: "GitHub",
            logo: toSvgDataUrl(`${logoSvg}\n`),
          },
        },
        skills: [
          {
            name: "github",
            description: "Triage GitHub work.",
            path: "skills/demo/SKILL.md",
            interface: {
              iconSmall: toSvgDataUrl(`${iconSmallSvg}\n`),
              iconLarge: toSvgDataUrl(`${iconLargeSvg}\n`),
            },
          },
        ],
      },
    });

    await bridge.close();
  });

  it("implements host fetch state for pinned threads and global state", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-1",
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "thread-titles" }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-2",
      method: "POST",
      url: "vscode://codex/set-thread-pinned",
      body: JSON.stringify({ threadId: "thr_123", pinned: true }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-3",
      method: "POST",
      url: "vscode://codex/list-pinned-threads",
    });

    await waitForCondition(() => emittedMessages.length >= 4);

    expect(getFetchResponse(emittedMessages, "fetch-1")).toEqual({
      type: "fetch-response",
      requestId: "fetch-1",
      responseType: "success",
      status: 200,
      headers: {
        "content-type": "application/json",
      },
      bodyJsonString: JSON.stringify({
        value: {},
      }),
    });

    expect(emittedMessages).toContainEqual({
      type: "pinned-threads-updated",
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-3")).toEqual({
      threadIds: ["thr_123"],
    });

    await bridge.close();
  });

  it("hydrates and persists pinned threads through Codex Desktop global state", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-pinned-threads-"));
    tempDirs.push(tempDirectory);
    const codexHome = join(tempDirectory, "codex-home");
    await mkdir(codexHome, { recursive: true });
    const globalStatePath = join(codexHome, ".codex-global-state.json");
    await writeFile(
      globalStatePath,
      JSON.stringify({
        "pinned-thread-ids": ["thr_existing"],
      }),
      "utf8",
    );

    const bridge = await createBridge(children, {
      codexHomePath: codexHome,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-pins",
      method: "POST",
      url: "vscode://codex/list-pinned-threads",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "pin-new",
      method: "POST",
      url: "vscode://codex/set-thread-pinned",
      body: JSON.stringify({ threadId: "thr_new", pinned: true }),
    });

    await waitForCondition(() => emittedMessages.length >= 3);

    expect(getFetchJsonBody(emittedMessages, "fetch-pins")).toEqual({
      threadIds: ["thr_existing"],
    });

    await bridge.close();

    await expect(readFile(globalStatePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      "pinned-thread-ids": ["thr_existing", "thr_new"],
    });
  });

  it("publishes shared object updates and opens the onboarding workspace picker", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);

    const bridge = await createBridge(children, { codexHomePath: codexHome });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "shared-object-subscribe",
      key: "host_config",
    });

    await bridge.forwardBridgeMessage({
      type: "electron-onboarding-pick-workspace-or-create-default",
      defaultProjectName: "Playground",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-1",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-2",
      method: "POST",
      url: "vscode://codex/workspace-root-options",
    });

    await waitForCondition(() =>
      emittedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          "requestId" in message &&
          message.type === "fetch-response" &&
          message.requestId === "fetch-2",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "shared-object-updated",
      key: "host_config",
      value: {
        id: "local",
        display_name: "Local",
        kind: "local",
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "pocodex-open-workspace-root-picker",
      context: "onboarding",
      initialPath: homedir(),
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-1")).toEqual({
      roots: [],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-2")).toEqual({
      roots: [],
      labels: {},
    });

    await bridge.close();
  });

  it("creates on attach, ignores early resize, and rebinds terminal sessions by conversation", async () => {
    process.env.SHELL = "/bin/zsh";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-resize",
      sessionId: "missing-before-attach",
      cols: 120,
      rows: 40,
    });

    expect(emittedMessages).toEqual([]);

    await bridge.forwardBridgeMessage({
      type: "terminal-attach",
      sessionId: "term-1",
      conversationId: "conv-1",
      cwd: TEST_WORKSPACE_ROOT,
      cols: 120,
      rows: 40,
    });

    expect(mockPtys).toHaveLength(1);
    expect(mockPtys[0]?.file).toBe("/bin/zsh");
    expect(emittedMessages).toContainEqual({
      type: "terminal-attached",
      sessionId: "term-1",
      cwd: TEST_WORKSPACE_ROOT,
      shell: "/bin/zsh",
    });

    mockPtys[0]?.emitData("prompt> ");
    await waitForCondition(() =>
      emittedMessages.some(
        (message) => isBridgeMessage(message, "terminal-data") && message.sessionId === "term-1",
      ),
    );

    emittedMessages.length = 0;

    await bridge.forwardBridgeMessage({
      type: "terminal-attach",
      sessionId: "term-2",
      conversationId: "conv-1",
      cwd: TEST_WORKSPACE_ROOT,
      cols: 100,
      rows: 30,
    });

    expect(mockPtys).toHaveLength(1);
    expect(mockPtys[0]?.resizeCalls.at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(emittedMessages).toContainEqual({
      type: "terminal-init-log",
      sessionId: "term-2",
      log: "prompt> ",
    });
    expect(emittedMessages).toContainEqual({
      type: "terminal-attached",
      sessionId: "term-2",
      cwd: TEST_WORKSPACE_ROOT,
      shell: "/bin/zsh",
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-write",
      sessionId: "term-2",
      data: "pwd\n",
    });

    expect(mockPtys[0]?.writes.at(-1)).toBe("pwd\n");

    await bridge.close();
  });

  it("writes, runs actions, resizes, and reports terminal errors", async () => {
    process.env.SHELL = "/bin/zsh";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-create",
      sessionId: "term-2",
      conversationId: "conv-2",
      cwd: TEST_WORKSPACE_ROOT,
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-write",
      sessionId: "term-2",
      data: "ls\n",
    });
    await bridge.forwardBridgeMessage({
      type: "terminal-run-action",
      sessionId: "term-2",
      cwd: TEST_WORKSPACE_ROOT,
      command: "pwd",
    });
    await bridge.forwardBridgeMessage({
      type: "terminal-resize",
      sessionId: "term-2",
      cols: 140,
      rows: 50,
    });
    await bridge.forwardBridgeMessage({
      type: "terminal-write",
      sessionId: "missing-session",
      data: "noop",
    });

    expect(mockPtys[0]?.writes).toEqual([`ls\n`, `cd '${TEST_WORKSPACE_ROOT}' && pwd\n`]);
    expect(mockPtys[0]?.resizeCalls.at(-1)).toEqual({ cols: 140, rows: 50 });
    expect(emittedMessages).toContainEqual({
      type: "terminal-error",
      sessionId: "missing-session",
      message: "Terminal session is not available.",
    });

    await bridge.close();
  });

  it("force-syncs cwd, emits exit, and disposes terminal sessions on bridge close", async () => {
    process.env.SHELL = "/bin/zsh";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-terminal-cwd-"));
    tempDirs.push(tempDirectory);

    await bridge.forwardBridgeMessage({
      type: "terminal-create",
      sessionId: "term-3",
      conversationId: "conv-3",
      cwd: TEST_WORKSPACE_ROOT,
    });

    await bridge.forwardBridgeMessage({
      type: "terminal-attach",
      sessionId: "term-3",
      conversationId: "conv-3",
      cwd: tempDirectory,
      forceCwdSync: true,
    });

    expect(mockPtys[0]?.writes.at(-1)).toBe(`cd '${tempDirectory}'\n`);
    expect(emittedMessages).toContainEqual({
      type: "terminal-attached",
      sessionId: "term-3",
      cwd: tempDirectory,
      shell: "/bin/zsh",
    });

    emittedMessages.length = 0;
    mockPtys[0]?.emitExit(17);

    await waitForCondition(() =>
      emittedMessages.some(
        (message) => isBridgeMessage(message, "terminal-exit") && message.sessionId === "term-3",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "terminal-exit",
      sessionId: "term-3",
      code: 17,
      signal: null,
    });

    emittedMessages.length = 0;

    await bridge.forwardBridgeMessage({
      type: "terminal-create",
      sessionId: "term-4",
      conversationId: "conv-4",
      cwd: TEST_WORKSPACE_ROOT,
    });

    expect(mockPtys[1]?.killed).toBe(false);
    await bridge.close();
    expect(mockPtys[1]?.killed).toBe(true);
    expect(emittedMessages).not.toContainEqual(
      expect.objectContaining({
        type: "terminal-exit",
        sessionId: "term-4",
      }),
    );
  });

  it("does not wait for the close fallback when the app-server exits synchronously", async () => {
    const bridge = await createBridge(children);

    vi.useFakeTimers();
    try {
      let settled = false;
      const closePromise = bridge.close().then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(999);

      expect(settled).toBe(true);
      await closePromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the workspace root picker for add-project host actions", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "electron-add-new-workspace-root-option",
    });

    await bridge.forwardBridgeMessage({
      type: "electron-pick-workspace-root-option",
    });

    expect(emittedMessages).toContainEqual({
      type: "pocodex-open-workspace-root-picker",
      context: "manual",
      initialPath: homedir(),
    });
    expect(
      emittedMessages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: unknown }).type === "pocodex-open-workspace-root-picker",
      ),
    ).toHaveLength(2);

    await bridge.close();
  });

  it("opens the workspace root picker when add-workspace-root-option is missing a root", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-add-root-missing",
      method: "POST",
      url: "vscode://codex/add-workspace-root-option",
      body: JSON.stringify({}),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-add-root-missing")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-add-root-missing")).toEqual({
      success: false,
      root: "",
    });
    expect(emittedMessages).toContainEqual({
      type: "pocodex-open-workspace-root-picker",
      context: "manual",
      initialPath: homedir(),
    });

    await bridge.close();
  });

  it("does not emit a top-level error when archiving a thread fails", async () => {
    mockLocalRequestErrors.set("thread/archive", "Thread not found");
    const bridge = await createBridge(children);
    const errors: Error[] = [];
    bridge.on("error", (error) => {
      errors.push(error);
    });

    await bridge.forwardBridgeMessage({
      type: "archive-thread",
      conversationId: "thr_test",
      requestId: "archive-1",
    });

    await waitForCondition(() =>
      (children.at(-1)?.writes ?? "").includes('"method":"thread/archive"'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([]);

    await bridge.close();
  });

  it("resolves archive requests for the desktop webview after archiving succeeds", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "archive-thread",
      conversationId: "thr_test",
      requestId: "archive-1",
    });

    await waitForCondition(() =>
      emittedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: unknown }).type === "serverRequest/resolved",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "serverRequest/resolved",
      params: {
        threadId: "thr_test",
        requestId: "archive-1",
      },
    });

    await bridge.close();
  });

  it("handles archive mcp requests locally for the desktop webview", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const child = children.at(-1);
    const writesBefore = child?.writes ?? "";

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "req-archive-1",
        method: "thread/archive",
        params: {
          threadId: "thr_test",
        },
      },
    });

    await waitForCondition(() =>
      emittedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: unknown }).type === "mcp-response",
      ),
    );

    expect(emittedMessages).toContainEqual({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: "req-archive-1",
        result: {
          ok: true,
        },
      },
    });
    expect((child?.writes ?? "").slice(writesBefore.length)).not.toContain('"id":"req-archive-1"');
    expect((child?.writes ?? "").slice(writesBefore.length)).not.toContain(
      '"method":"thread/archive"',
    );

    await bridge.close();
  });
});
