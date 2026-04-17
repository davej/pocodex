import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  describeAppServerBridge,
  createBridge,
  mockLocalThreadList,
  tempDirs,
  TEST_WORKSPACE_ROOT,
  TEST_PROJECT_ALPHA_ROOT,
  TEST_PROJECT_BETA_ROOT,
  TEST_NOT_AUTO_ADDED_ROOT,
  writeWorkspaceRootRegistry,
  getFetchResponse,
  getFetchJsonBody,
  waitForCondition,
} from "./support/app-server-bridge-test-kit.js";

describeAppServerBridge(({ children }) => {
  it("treats a missing workspace registry as pristine with no projects", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    mockLocalThreadList.data = [
      {
        id: "thr_a",
        cwd: TEST_PROJECT_ALPHA_ROOT,
      },
      {
        id: "thr_b",
        cwd: TEST_PROJECT_BETA_ROOT,
      },
    ];

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-active-roots",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-root-options",
      method: "POST",
      url: "vscode://codex/workspace-root-options",
    });

    await waitForCondition(() => emittedMessages.length >= 2);

    expect(getFetchJsonBody(emittedMessages, "fetch-active-roots")).toEqual({
      roots: [],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-root-options")).toEqual({
      roots: [],
      labels: {},
    });

    expect(children.at(-1)?.writes ?? "").not.toContain('"method":"thread/list"');

    await bridge.close();
  });

  it("persists workspace roots, labels, and active project across restarts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");

    const firstBridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });

    await firstBridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-add-root",
      method: "POST",
      url: "vscode://codex/add-workspace-root-option",
      body: JSON.stringify({
        root: TEST_PROJECT_ALPHA_ROOT,
        setActive: false,
      }),
    });

    await firstBridge.forwardBridgeMessage({
      type: "electron-rename-workspace-root-option",
      root: TEST_PROJECT_ALPHA_ROOT,
      label: "Project Alpha",
    });

    await firstBridge.forwardBridgeMessage({
      type: "electron-update-workspace-root-options",
      roots: [TEST_PROJECT_ALPHA_ROOT, TEST_WORKSPACE_ROOT],
    });

    await firstBridge.forwardBridgeMessage({
      type: "electron-set-active-workspace-root",
      root: TEST_PROJECT_ALPHA_ROOT,
    });

    await firstBridge.close();

    mockLocalThreadList.data = [
      {
        id: "thr_new",
        cwd: TEST_NOT_AUTO_ADDED_ROOT,
      },
    ];

    const secondBridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    secondBridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await secondBridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-active-roots",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await secondBridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-root-options",
      method: "POST",
      url: "vscode://codex/workspace-root-options",
    });

    await waitForCondition(() => emittedMessages.length >= 2);

    expect(getFetchJsonBody(emittedMessages, "fetch-active-roots")).toEqual({
      roots: [TEST_PROJECT_ALPHA_ROOT, TEST_WORKSPACE_ROOT],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-root-options")).toEqual({
      roots: [TEST_PROJECT_ALPHA_ROOT, TEST_WORKSPACE_ROOT],
      labels: {
        [TEST_PROJECT_ALPHA_ROOT]: "Project Alpha",
        [TEST_WORKSPACE_ROOT]: "pocodex",
      },
    });

    await secondBridge.close();
  });

  it("lists workspace directory entries for the local workspace browser", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-browser-"));
    tempDirs.push(tempDirectory);
    const emptyDirectory = join(tempDirectory, "empty-dir");
    const sourceDirectory = join(tempDirectory, "src");
    await mkdir(emptyDirectory, { recursive: true });
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(tempDirectory, "README.md"), "fixture\n", "utf8");
    await writeFile(join(tempDirectory, ".env"), "SECRET=value\n", "utf8");
    await writeFile(join(sourceDirectory, "index.ts"), "export {};\n", "utf8");
    await writeFile(join(sourceDirectory, ".secret.ts"), "export const hidden = true;\n", "utf8");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-workspace-directory-root",
      method: "POST",
      url: "vscode://codex/workspace-directory-entries",
      body: JSON.stringify({
        params: {
          workspaceRoot: tempDirectory,
          includeHidden: false,
        },
      }),
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-workspace-directory-nested",
      method: "POST",
      url: "vscode://codex/workspace-directory-entries",
      body: JSON.stringify({
        params: {
          workspaceRoot: tempDirectory,
          directoryPath: "src",
          includeHidden: true,
        },
      }),
    });

    await waitForCondition(
      () =>
        Boolean(getFetchResponse(emittedMessages, "fetch-workspace-directory-root")) &&
        Boolean(getFetchResponse(emittedMessages, "fetch-workspace-directory-nested")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-workspace-directory-root")).toEqual({
      directoryPath: "",
      entries: [
        {
          name: "empty-dir",
          path: "empty-dir",
          type: "directory",
        },
        {
          name: "src",
          path: "src",
          type: "directory",
        },
        {
          name: "README.md",
          path: "README.md",
          type: "file",
        },
      ],
    });

    expect(getFetchJsonBody(emittedMessages, "fetch-workspace-directory-nested")).toEqual({
      directoryPath: "src",
      entries: [
        {
          name: "index.ts",
          path: "src/index.ts",
          type: "file",
        },
        {
          name: ".secret.ts",
          path: "src/.secret.ts",
          type: "file",
        },
      ],
    });

    await bridge.close();
  });

  it("rejects workspace directory requests outside the selected workspace root", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-browser-"));
    tempDirs.push(tempDirectory);
    const sourceDirectory = join(tempDirectory, "src");
    await mkdir(sourceDirectory, { recursive: true });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-workspace-directory-outside-root",
      method: "POST",
      url: "vscode://codex/workspace-directory-entries",
      body: JSON.stringify({
        params: {
          workspaceRoot: sourceDirectory,
          directoryPath: dirname(tempDirectory),
        },
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-workspace-directory-outside-root")),
    );

    expect(
      getFetchResponse(emittedMessages, "fetch-workspace-directory-outside-root"),
    ).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-workspace-directory-outside-root",
      responseType: "error",
      status: 400,
      error: "Directory path must stay within the selected workspace root.",
    });

    await bridge.close();
  });

  it("persists host persisted atoms across restarts", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-persisted-atoms-"));
    tempDirs.push(tempDirectory);
    const persistedAtomRegistryPath = join(tempDirectory, "persisted-atoms.json");

    const firstBridge = await createBridge(children, {
      persistedAtomRegistryPath,
    });

    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "agent-mode",
      value: "full-access",
    });
    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "skip-full-access-confirm",
      value: true,
    });
    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "transient-key",
      value: "stale",
    });
    await firstBridge.forwardBridgeMessage({
      type: "persisted-atom-update",
      key: "transient-key",
      deleted: true,
    });

    await firstBridge.close();

    await expect(readFile(persistedAtomRegistryPath, "utf8")).resolves.toContain(
      '"agent-mode": "full-access"',
    );
    await expect(readFile(persistedAtomRegistryPath, "utf8")).resolves.not.toContain(
      '"transient-key"',
    );

    const secondBridge = await createBridge(children, {
      persistedAtomRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    secondBridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await secondBridge.forwardBridgeMessage({
      type: "persisted-atom-sync-request",
    });

    await waitForCondition(() => emittedMessages.length >= 1);

    expect(emittedMessages).toContainEqual({
      type: "persisted-atom-sync",
      state: {
        "agent-mode": "full-access",
        "skip-full-access-confirm": true,
      },
    });

    await secondBridge.close();
  });

  it("lists workspace root picker directories and defaults to the host home directory", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    await mkdir(join(tempDirectory, "beta"), { recursive: true });
    await mkdir(join(tempDirectory, "Alpha"), { recursive: true });
    await writeFile(join(tempDirectory, "README.md"), "fixture\n", "utf8");

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-home",
        method: "workspace-root-picker/list",
      }),
    ).resolves.toEqual({
      requestId: "ipc-home",
      type: "response",
      resultType: "success",
      result: {
        currentPath: homedir(),
        parentPath: dirname(homedir()) === homedir() ? null : dirname(homedir()),
        homePath: homedir(),
        entries: expect.any(Array),
      },
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-list",
        method: "workspace-root-picker/list",
        params: {
          path: tempDirectory,
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-list",
      type: "response",
      resultType: "success",
      result: {
        currentPath: tempDirectory,
        parentPath: dirname(tempDirectory),
        homePath: homedir(),
        entries: [
          {
            name: "Alpha",
            path: join(tempDirectory, "Alpha"),
          },
          {
            name: "beta",
            path: join(tempDirectory, "beta"),
          },
        ],
      },
    });

    await bridge.close();
  });

  it("rejects invalid workspace root picker paths", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const filePath = join(tempDirectory, "file.txt");
    await writeFile(filePath, "fixture\n", "utf8");

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-relative",
        method: "workspace-root-picker/list",
        params: {
          path: "relative/path",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-relative",
      type: "response",
      resultType: "error",
      error: "Folder path must be absolute.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-file",
        method: "workspace-root-picker/list",
        params: {
          path: filePath,
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-file",
      type: "response",
      resultType: "error",
      error: "Choose an existing folder.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-root",
        method: "workspace-root-picker/list",
        params: {
          path: "/",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-root",
      type: "response",
      resultType: "success",
      result: {
        currentPath: "/",
        parentPath: null,
        homePath: homedir(),
        entries: expect.any(Array),
      },
    });

    await bridge.close();
  });

  it("normalizes WSL UNC workspace roots for picker and browser flows", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const projectRoot = join(tempDirectory, "project-alpha");
    await mkdir(projectRoot, { recursive: true });
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-wsl-picker-list",
        method: "workspace-root-picker/list",
        params: {
          path: convertLinuxPathToWslUnc(tempDirectory, "wsl$"),
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-wsl-picker-list",
      type: "response",
      resultType: "success",
      result: {
        currentPath: tempDirectory,
        parentPath: dirname(tempDirectory),
        homePath: homedir(),
        entries: [
          {
            name: "project-alpha",
            path: projectRoot,
          },
        ],
      },
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-wsl-browser-list",
        method: "workspace-root-browser/list",
        params: {
          root: convertLinuxPathToWslUnc(tempDirectory, "wsl.localhost"),
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-wsl-browser-list",
      type: "response",
      resultType: "success",
      result: {
        root: tempDirectory,
        parentRoot: dirname(tempDirectory),
        homeDir: homedir(),
        entries: [
          {
            name: "project-alpha",
            path: projectRoot,
          },
        ],
      },
    });

    await bridge.close();
  });

  it("normalizes WSL Windows-style workspace roots before validation", async () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-windows-picker-list",
        method: "workspace-root-picker/list",
        params: {
          path: "C:\\missing\\project",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-windows-picker-list",
      type: "response",
      resultType: "error",
      error: "Choose an existing folder.",
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-add-root-windows-style",
      method: "POST",
      url: "vscode://codex/add-workspace-root-option",
      body: JSON.stringify({
        root: "C:\\missing\\project",
        setActive: false,
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-add-root-windows-style")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-add-root-windows-style")).toEqual({
      success: false,
      root: "/mnt/c/missing/project",
      error: "Project path does not exist on the host filesystem.",
    });

    await bridge.close();
  });

  it("creates workspace root picker directories and rejects invalid names", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);

    const bridge = await createBridge(children);

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "new-project",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create",
      type: "response",
      resultType: "success",
      result: {
        currentPath: join(tempDirectory, "new-project"),
      },
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create-empty",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "  ",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create-empty",
      type: "response",
      resultType: "error",
      error: "Folder name cannot be empty.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create-invalid",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "nested/path",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create-invalid",
      type: "response",
      resultType: "error",
      error: "Folder name cannot contain path separators.",
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-create-existing",
        method: "workspace-root-picker/create-directory",
        params: {
          parentPath: tempDirectory,
          name: "new-project",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-create-existing",
      type: "response",
      resultType: "error",
      error: "That folder already exists.",
    });

    await bridge.close();
  });

  it("confirms new workspace root picker selections, persists them, and emits updates", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const projectRoot = join(tempDirectory, "project-alpha");
    await mkdir(projectRoot, { recursive: true });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-confirm",
        method: "workspace-root-picker/confirm",
        params: {
          path: projectRoot,
          context: "manual",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-confirm",
      type: "response",
      resultType: "success",
      result: {
        action: "added",
        root: projectRoot,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "workspace-root-options-updated",
    });
    expect(emittedMessages).toContainEqual({
      type: "active-workspace-roots-updated",
    });
    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      `"activeRoot": "${projectRoot}"`,
    );

    await bridge.close();
  });

  it("activates existing workspace root picker selections without duplicating roots", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const alphaRoot = join(tempDirectory, "alpha");
    const betaRoot = join(tempDirectory, "beta");
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    const workspaceRootRegistryPath = await writeWorkspaceRootRegistry(tempDirectory, {
      roots: [alphaRoot, betaRoot],
      activeRoot: betaRoot,
    });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-confirm-existing",
        method: "workspace-root-picker/confirm",
        params: {
          path: alphaRoot,
          context: "manual",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-confirm-existing",
      type: "response",
      resultType: "success",
      result: {
        action: "activated",
        root: alphaRoot,
      },
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-active-roots-after-confirm",
      method: "POST",
      url: "vscode://codex/active-workspace-roots",
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-active-roots-after-confirm")),
    );

    expect(getFetchJsonBody(emittedMessages, "fetch-active-roots-after-confirm")).toEqual({
      roots: [alphaRoot, betaRoot],
    });
    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      `"activeRoot": "${alphaRoot}"`,
    );

    await bridge.close();
  });

  it("emits onboarding success and failure for workspace root picker confirm and cancel", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const projectRoot = join(tempDirectory, "project-onboarding");
    await mkdir(projectRoot, { recursive: true });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-confirm-onboarding",
        method: "workspace-root-picker/confirm",
        params: {
          path: projectRoot,
          context: "onboarding",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-confirm-onboarding",
      type: "response",
      resultType: "success",
      result: {
        action: "added",
        root: projectRoot,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: true,
    });

    emittedMessages.length = 0;

    await expect(
      bridge.handleIpcRequest({
        requestId: "ipc-cancel-onboarding",
        method: "workspace-root-picker/cancel",
        params: {
          context: "onboarding",
        },
      }),
    ).resolves.toEqual({
      requestId: "ipc-cancel-onboarding",
      type: "response",
      resultType: "success",
      result: {
        cancelled: true,
      },
    });

    expect(emittedMessages).toContainEqual({
      type: "electron-onboarding-pick-workspace-or-create-default-result",
      success: false,
    });

    await bridge.close();
  });

  it("supports workspace-root-option-picked as a compatibility path", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-root-picker-"));
    tempDirs.push(tempDirectory);
    const workspaceRootRegistryPath = join(tempDirectory, "workspace-roots.json");
    const projectRoot = join(tempDirectory, "project-picked");
    await mkdir(projectRoot, { recursive: true });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "workspace-root-option-picked",
      root: projectRoot,
    });

    expect(emittedMessages).toContainEqual({
      type: "workspace-root-options-updated",
    });
    expect(emittedMessages).toContainEqual({
      type: "active-workspace-roots-updated",
    });
    await expect(readFile(workspaceRootRegistryPath, "utf8")).resolves.toContain(
      `"activeRoot": "${projectRoot}"`,
    );

    await bridge.close();
  });
});

function convertLinuxPathToWslUnc(
  linuxPath: string,
  host: "wsl$" | "wsl.localhost" = "wsl$",
): string {
  const normalizedPath = linuxPath.replace(/^\/+/, "");
  const segments = normalizedPath.length > 0 ? normalizedPath.split("/") : [];
  return `\\\\${host}\\Ubuntu${segments.length > 0 ? `\\${segments.join("\\")}` : ""}`;
}
