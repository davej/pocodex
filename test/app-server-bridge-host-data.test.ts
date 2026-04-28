import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  describeAppServerBridge,
  createBridge,
  tempDirs,
  TEST_WORKSPACE_ROOT,
  TEST_MISSING_ROOT,
  getFetchResponse,
  getFetchJsonBody,
  waitForCondition,
} from "./support/app-server-bridge-test-kit.js";

describeAppServerBridge(({ children }) => {
  it("returns empty-state host metadata and reports existing paths", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-os",
      method: "POST",
      url: "vscode://codex/os-info",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-home",
      method: "POST",
      url: "vscode://codex/codex-home",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-copilot",
      method: "POST",
      url: "vscode://codex/get-copilot-api-proxy-info",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-config",
      method: "POST",
      url: "vscode://codex/mcp-codex-config",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-instructions",
      method: "POST",
      url: "vscode://codex/developer-instructions",
      body: JSON.stringify({
        params: {
          baseInstructions: "Use concise output.",
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-paths",
      method: "POST",
      url: "vscode://codex/paths-exist",
      body: JSON.stringify({
        paths: [TEST_WORKSPACE_ROOT, TEST_MISSING_ROOT],
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-ide-context",
      method: "POST",
      url: "vscode://codex/ide-context",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-recommended-skills",
      method: "POST",
      url: "vscode://codex/recommended-skills",
    });

    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-ide-context")));

    expect(getFetchJsonBody(emittedMessages, "fetch-os")).toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
      hasWsl: false,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-home")).toEqual({
      codexHome,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-copilot")).toEqual({});

    expect(getFetchJsonBody(emittedMessages, "fetch-config")).toEqual({
      ok: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-instructions")).toEqual({
      instructions: "Use concise output.",
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-paths")).toEqual({
      existingPaths: [TEST_WORKSPACE_ROOT],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-recommended-skills")).toEqual({
      repoRoot: join(codexHome, "vendor_imports", "skills"),
      skills: [],
    });

    expect(getFetchResponse(emittedMessages, "fetch-ide-context")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-ide-context",
      responseType: "error",
      status: 503,
      error: "IDE context is unavailable in Pocodex.",
    });

    await bridge.close();
  });

  it("generates thread titles for host fetch requests", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-thread-title",
      method: "POST",
      url: "vscode://codex/generate-thread-title",
      body: JSON.stringify({
        params: {
          hostId: "local",
          cwd: TEST_WORKSPACE_ROOT,
          prompt:
            "Spin up a subagent to explore [this repo](https://example.com) and report back the main entry points and key bridge files.",
        },
      }),
    });

    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-thread-title")));

    expect(getFetchJsonBody(emittedMessages, "fetch-thread-title")).toEqual({
      title: "explore this repo and report back the main entry points and…",
    });

    await bridge.close();
  });

  it("returns a projectless thread cwd and output directory for new chat startup", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);

    const bridge = await createBridge(children, { codexHomePath: codexHome });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-projectless-thread-cwd",
      method: "POST",
      url: "vscode://codex/projectless-thread-cwd",
      body: JSON.stringify({
        params: {
          prompt: "say connected",
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-projectless-thread-cwd")),
    );

    const outputDirectory = join(codexHome, "pocodex", "projectless-output");
    expect(getFetchJsonBody(emittedMessages, "fetch-projectless-thread-cwd")).toEqual({
      cwd: TEST_WORKSPACE_ROOT,
      outputDirectory,
      workspaceRoot: TEST_WORKSPACE_ROOT,
    });
    expect((await stat(outputDirectory)).isDirectory()).toBe(true);

    await bridge.close();
  });

  it("lists curated recommended skills from vendor imports", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;

    const repoRoot = join(codexHome, "vendor_imports", "skills");
    const createPlanSkillPath = join(repoRoot, "skills", ".curated", "create-plan");
    const lintReviewSkillPath = join(repoRoot, "skills", ".curated", "lint-review");
    await mkdir(createPlanSkillPath, { recursive: true });
    await mkdir(lintReviewSkillPath, { recursive: true });
    await writeFile(
      join(createPlanSkillPath, "SKILL.md"),
      `---
name: create-plan
description: Create a concise implementation plan.
metadata:
  short-description: Create a plan
icon-small: ./icon-small.svg
icon-large: ./icon-large.svg
---

# Create Plan
`,
      "utf8",
    );
    await writeFile(
      join(lintReviewSkillPath, "SKILL.md"),
      `---
name: lint-review
description: Review lint issues quickly.
---

# Lint Review
`,
      "utf8",
    );

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-recommended-skills",
      method: "POST",
      url: "vscode://codex/recommended-skills",
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-recommended-skills")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-recommended-skills")).toEqual({
      repoRoot,
      skills: [
        {
          id: "create-plan",
          name: "create-plan",
          description: "Create a concise implementation plan.",
          shortDescription: "Create a plan",
          repoPath: "skills/.curated/create-plan",
          path: "skills/.curated/create-plan",
          iconSmall: "./icon-small.svg",
          iconLarge: "./icon-large.svg",
        },
        {
          id: "lint-review",
          name: "lint-review",
          description: "Review lint issues quickly.",
          shortDescription: null,
          repoPath: "skills/.curated/lint-review",
          path: "skills/.curated/lint-review",
        },
      ],
    });

    await bridge.close();
  });

  it("reads and writes personal agents.md content from codex home", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    const agentsPath = join(codexHome, "agents.md");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-agents-read-empty",
      method: "POST",
      url: "vscode://codex/codex-agents-md",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-agents-save",
      method: "POST",
      url: "vscode://codex/codex-agents-md-save",
      body: JSON.stringify({
        params: {
          contents: "Use concise output.\n",
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-agents-read-saved",
      method: "POST",
      url: "vscode://codex/codex-agents-md",
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-agents-read-saved")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-agents-read-empty")).toEqual({
      path: agentsPath,
      contents: "",
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-agents-save")).toEqual({
      path: agentsPath,
    });

    expect(await readFile(agentsPath, "utf8")).toBe("Use concise output.\n");

    expect(getFetchJsonBody(emittedMessages, "fetch-agents-read-saved")).toEqual({
      path: agentsPath,
      contents: "Use concise output.\n",
    });

    await bridge.close();
  });

  it("reads skill contents through the webview read-file contract", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    const skillDirectory = join(codexHome, "vendor_imports", "skills", "demo");
    await mkdir(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(skillPath, "# Demo Skill\n\nUse concise output.\n", "utf8");

    const bridge = await createBridge(children, { codexHomePath: codexHome });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: skillPath,
        },
      }),
    });

    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-read-file")));

    expect(getFetchJsonBody(emittedMessages, "fetch-read-file")).toEqual({
      path: skillPath,
      contents: "# Demo Skill\n\nUse concise output.\n",
    });

    await bridge.close();
  });

  it("allows read-file under a registered workspace and rejects unsafe paths", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-read-file-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-read-file");
    await mkdir(projectRoot, { recursive: true });
    const workspaceFile = join(projectRoot, "README.md");
    await writeFile(workspaceFile, "# Project\n", "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await registerWorkspaceRoot(bridge, emittedMessages, projectRoot);

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file-workspace",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: workspaceFile,
        },
      }),
    });
    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file-outside",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: "/etc/hosts",
        },
      }),
    });
    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file-directory",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: projectRoot,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-read-file-directory")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-read-file-workspace")).toEqual({
      path: workspaceFile,
      contents: "# Project\n",
    });
    expect(getFetchResponse(emittedMessages, "fetch-read-file-outside")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-read-file-outside",
      responseType: "error",
      status: 403,
      error: "File path is outside Pocodex's allowed read roots.",
    });
    expect(getFetchResponse(emittedMessages, "fetch-read-file-directory")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-read-file-directory",
      responseType: "error",
      status: 400,
      error: "File path must point to a file.",
    });

    await bridge.close();
  });

  it("rejects unsupported browser bridge fetch URLs without proxying them", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const urls = [
      "http://127.0.0.1:8080/status",
      "http://192.168.1.20/admin",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/hosts",
      "https://example.com/api",
    ];

    for (const [index, url] of urls.entries()) {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: `fetch-unsupported-${index}`,
        method: "GET",
        url,
      });
    }

    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-unsupported-4")));

    for (const [index, url] of urls.entries()) {
      expect(getFetchResponse(emittedMessages, `fetch-unsupported-${index}`)).toMatchObject({
        type: "fetch-response",
        requestId: `fetch-unsupported-${index}`,
        responseType: "error",
        status: 501,
        error: `Unsupported absolute fetch URL: ${url}`,
      });
    }

    await bridge.close();
  });

  it("returns a fetch error for invalid read-file paths", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-read-file-invalid",
      method: "POST",
      url: "vscode://codex/read-file",
      body: JSON.stringify({
        params: {
          path: "skills/demo/SKILL.md",
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-read-file-invalid")),
    );

    expect(getFetchResponse(emittedMessages, "fetch-read-file-invalid")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-read-file-invalid",
      responseType: "error",
      status: 400,
      error: "File path must be absolute.",
    });

    await bridge.close();
  });

  it("lists local environments for a workspace root using the webview contract", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-gamma");
    await mkdir(join(projectRoot, ".codex", "environments"), { recursive: true });
    const environmentPath = join(projectRoot, ".codex", "environments", "environment.toml");
    await writeFile(
      environmentPath,
      [
        "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
        'name = "Project Gamma"',
        "version = 1",
        "",
        "[setup]",
        'script = "pnpm install"',
        "",
        "[setup.linux]",
        'script = "pnpm install --frozen-lockfile"',
        "",
        "[cleanup]",
        'script = "pnpm cleanup"',
        "",
        "[[actions]]",
        'name = "Run dev"',
        'icon = "run"',
        'command = "pnpm dev"',
        "",
      ].join("\n"),
      "utf8",
    );

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await registerWorkspaceRoot(bridge, emittedMessages, projectRoot);

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environments-list",
      method: "POST",
      url: "vscode://codex/local-environments",
      body: JSON.stringify({
        params: {
          workspaceRoot: projectRoot,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environments-list")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environments-list")).toEqual({
      environments: [
        {
          configPath: environmentPath,
          exists: true,
          type: "success",
          environment: {
            name: "Project Gamma",
            version: 1,
            setup: {
              script: "pnpm install",
              linux: {
                script: "pnpm install --frozen-lockfile",
              },
            },
            cleanup: {
              script: "pnpm cleanup",
            },
            actions: [
              {
                name: "Run dev",
                icon: "run",
                command: "pnpm dev",
              },
            ],
          },
        },
      ],
    });

    await bridge.close();
  });

  it("reports parse errors for a broken local environment without failing the fetch", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-delta");
    await mkdir(join(projectRoot, ".codex", "environments"), { recursive: true });
    const environmentPath = join(projectRoot, ".codex", "environments", "environment.toml");
    await writeFile(
      environmentPath,
      [
        "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
        'name = "Broken"',
        "[setup",
        'script = "pnpm install"',
      ].join("\n"),
      "utf8",
    );

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await registerWorkspaceRoot(bridge, emittedMessages, projectRoot);

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-broken-list",
      method: "POST",
      url: "vscode://codex/local-environments",
      body: JSON.stringify({
        params: {
          workspaceRoot: projectRoot,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-broken-config",
      method: "POST",
      url: "vscode://codex/local-environment-config",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-broken-read",
      method: "POST",
      url: "vscode://codex/local-environment",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environment-broken-read")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-broken-list")).toEqual({
      environments: [
        {
          configPath: environmentPath,
          exists: true,
          type: "error",
          error: {
            message: expect.any(String),
          },
        },
      ],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-broken-config")).toEqual({
      configPath: environmentPath,
      exists: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-broken-read")).toEqual({
      environment: {
        type: "error",
        error: {
          message: expect.any(String),
        },
      },
    });

    await bridge.close();
  });

  it("saves raw local environment TOML through the config-save endpoint", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-epsilon");
    await mkdir(projectRoot, { recursive: true });
    const environmentPath = join(projectRoot, ".codex", "environments", "environment.toml");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await registerWorkspaceRoot(bridge, emittedMessages, projectRoot);

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-config-missing",
      method: "POST",
      url: "vscode://codex/local-environment-config",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    const rawEnvironment = [
      'name = "Project Epsilon"',
      "version = 1",
      "",
      "[setup]",
      'script = "pnpm install"',
      "",
      "[setup.darwin]",
      'script = "pnpm install:mac"',
      "",
      "[cleanup]",
      'script = "pnpm cleanup"',
      "",
      "[cleanup.linux]",
      'script = "pnpm cleanup:linux"',
      "",
      "[[actions]]",
      'name = "Run dev"',
      'icon = "run"',
      'command = "pnpm dev"',
      "",
      "[[actions]]",
      'name = "Test"',
      'icon = "test"',
      'command = "pnpm test"',
      'platform = "linux"',
      "",
    ].join("\n");

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-config-save",
      method: "POST",
      url: "vscode://codex/local-environment-config-save",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
          raw: rawEnvironment,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-read-saved",
      method: "POST",
      url: "vscode://codex/local-environment",
      body: JSON.stringify({
        params: {
          configPath: environmentPath,
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environment-read-saved")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-config-missing")).toEqual({
      configPath: environmentPath,
      exists: false,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-config-save")).toEqual({
      configPath: environmentPath,
      exists: true,
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-local-environment-read-saved")).toEqual({
      environment: {
        type: "success",
        environment: {
          name: "Project Epsilon",
          version: 1,
          setup: {
            script: "pnpm install",
            darwin: {
              script: "pnpm install:mac",
            },
          },
          cleanup: {
            script: "pnpm cleanup",
            linux: {
              script: "pnpm cleanup:linux",
            },
          },
          actions: [
            {
              name: "Run dev",
              icon: "run",
              command: "pnpm dev",
            },
            {
              name: "Test",
              icon: "test",
              command: "pnpm test",
              platform: "linux",
            },
          ],
        },
      },
    });

    const savedFile = await readFile(environmentPath, "utf8");
    expect(savedFile).toContain("# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY");
    expect(savedFile).toContain('name = "Project Epsilon"');
    expect(savedFile).toContain("[cleanup.linux]");
    expect(savedFile).toContain('platform = "linux"');

    await bridge.close();
  });

  it("rejects local environment config paths outside registered workspace roots", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-local-environments-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-zeta");
    const outsideRoot = join(tempDirectory, "outside-project");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(outsideRoot, ".codex", "environments"), { recursive: true });
    const outsideEnvironmentPath = join(outsideRoot, ".codex", "environments", "environment.toml");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });
    await registerWorkspaceRoot(bridge, emittedMessages, projectRoot);

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-local-environment-outside-save",
      method: "POST",
      url: "vscode://codex/local-environment-config-save",
      body: JSON.stringify({
        params: {
          configPath: outsideEnvironmentPath,
          raw: 'name = "Outside"\nversion = 1\n',
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-local-environment-outside-save")),
    );

    expect(getFetchResponse(emittedMessages, "fetch-local-environment-outside-save")).toMatchObject(
      {
        type: "fetch-response",
        requestId: "fetch-local-environment-outside-save",
        responseType: "error",
        status: 403,
        error: "Local environment config path is outside registered workspace roots.",
      },
    );

    await bridge.close();
  });
});

async function registerWorkspaceRoot(
  bridge: {
    forwardBridgeMessage: (message: unknown) => Promise<void>;
  },
  emittedMessages: unknown[],
  root: string,
): Promise<void> {
  const requestId = `register-workspace-root:${root}`;
  await bridge.forwardBridgeMessage({
    type: "fetch",
    requestId,
    method: "POST",
    url: "vscode://codex/add-workspace-root-option",
    body: JSON.stringify({
      root,
    }),
  });
  await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, requestId)));
}
