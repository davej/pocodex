import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asarMock = vi.hoisted(() => ({
  extractFile: vi.fn((_appAsarPath: string, _filename: string) => Buffer.alloc(0)),
  listPackage: vi.fn((_appAsarPath: string, _options: { isPack: boolean }) => [] as string[]),
  statFile: vi.fn(),
}));
vi.mock("@electron/asar", () => asarMock);

import {
  ensureCodexCliBinary,
  loadCodexBundle,
  loadCodexDesktopMetadata,
  resolveDefaultCodexAppPath,
} from "../src/lib/codex-bundle.js";

describe("codex-bundle", () => {
  const tempDirs: string[] = [];
  const desktopPackagesByAppAsarPath = new Map<
    string,
    {
      version?: string;
      codexBuildFlavor?: string;
      codexBuildNumber?: string;
    }
  >();
  const originalHome = process.env.HOME;
  const originalPocodexAppPath = process.env.POCODEX_APP_PATH;

  beforeEach(() => {
    desktopPackagesByAppAsarPath.clear();
    asarMock.extractFile.mockImplementation((appAsarPath, filename) => {
      if (filename === "package.json") {
        const packageJson = desktopPackagesByAppAsarPath.get(appAsarPath) ?? {
          version: "26.313.5234.0",
          codexBuildFlavor: "prod",
          codexBuildNumber: "5234",
        };
        return Buffer.from(JSON.stringify(packageJson), "utf8");
      }

      throw new Error(`Unexpected asar extract for ${filename}`);
    });
    asarMock.listPackage.mockReturnValue([]);
    asarMock.statFile.mockReset();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalPocodexAppPath === undefined) {
      delete process.env.POCODEX_APP_PATH;
    } else {
      process.env.POCODEX_APP_PATH = originalPocodexAppPath;
    }

    await Promise.all(
      tempDirs.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it("loads metadata from a Windows-style app layout", async () => {
    const appPath = await createWindowsInstallLayout();

    await expect(loadCodexDesktopMetadata(appPath)).resolves.toEqual({
      appPath,
      appAsarPath: join(appPath, "resources", "app.asar"),
      cliBinaryPath: join(appPath, "resources", "codex"),
      layout: "windows-app",
      version: "26.313.5234.0",
      buildFlavor: "prod",
      buildNumber: "5234",
    });
  });

  it("returns an executable bundled cli path", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pocodex-home-"));
    tempDirs.push(homeDirectory);
    process.env.HOME = homeDirectory;

    const appPath = await createWindowsInstallLayout();
    const sourceCliPath = join(appPath, "resources", "codex");
    await chmod(sourceCliPath, 0o644);

    const stagedCliPath = await ensureCodexCliBinary(appPath);

    await expect(readFile(stagedCliPath, "utf8")).resolves.toBe("#!/bin/sh\nexit 0\n");
    await expect(access(stagedCliPath, constants.X_OK)).resolves.toBeUndefined();
    expect(
      stagedCliPath === sourceCliPath || ((await stat(stagedCliPath)).mode & 0o111) !== 0,
    ).toBe(true);
  });

  it("stores the extracted webview in a dedicated cache directory", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pocodex-home-"));
    tempDirs.push(homeDirectory);
    process.env.HOME = homeDirectory;

    const appPath = await createWindowsInstallLayout();
    const versionCacheRoot = join(homeDirectory, ".cache", "pocodex", "26.313.5234.0__prod__5234");
    await mkdir(join(versionCacheRoot, "__cli", "windows-app"), { recursive: true });
    await writeFile(join(versionCacheRoot, "__cli", "windows-app", "codex"), "cached", "utf8");

    asarMock.listPackage.mockReturnValue([
      "/webview/index.html",
      "/webview/assets/app-test.png",
      "/webview/assets/use-auth-test.js",
    ]);
    asarMock.statFile.mockReturnValue({ size: 1 });
    asarMock.extractFile.mockImplementation((_appAsarPath, filename) => {
      if (filename === "package.json") {
        return Buffer.from(
          JSON.stringify({
            version: "26.313.5234.0",
            codexBuildFlavor: "prod",
            codexBuildNumber: "5234",
          }),
          "utf8",
        );
      }
      if (filename === "webview/index.html") {
        return Buffer.from("<html>codex</html>", "utf8");
      }
      if (filename === "webview/assets/app-test.png") {
        return Buffer.from("png");
      }
      if (filename === "webview/assets/use-auth-test.js") {
        return Buffer.from(
          "function T(){let e=(0,p.useContext)(m);if(!e)throw Error(`useAuth must be used within AuthProvider`);return e}function E(e){return D(s(e))}const auth={accountId:null,userId:null};",
          "utf8",
        );
      }

      throw new Error(`Unexpected asar extract for ${filename}`);
    });

    const bundle = await loadCodexBundle(appPath);

    expect(bundle.webviewRoot).toBe(join(versionCacheRoot, "__webview"));
    expect(bundle.faviconHref).toBe("./assets/app-test.png");
    await expect(bundle.readIndexHtml()).resolves.toBe("<html>codex</html>");
    await expect(
      readFile(join(bundle.webviewRoot, "assets", "use-auth-test.js"), "utf8"),
    ).resolves.toContain(
      'window.electronBridge?.getSharedObjectSnapshotValue?.("pocodex_auth_state")',
    );
    await expect(
      readFile(join(bundle.webviewRoot, "assets", "use-auth-test.js"), "utf8"),
    ).resolves.toContain("email:e.email??t.email??null");
    await expect(
      readFile(join(versionCacheRoot, "__cli", "windows-app", "codex"), "utf8"),
    ).resolves.toBe("cached");
  });

  it("patches an existing cached webview before serving it", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pocodex-home-"));
    tempDirs.push(homeDirectory);
    process.env.HOME = homeDirectory;

    const appPath = await createWindowsInstallLayout();
    const webviewRoot = join(
      homeDirectory,
      ".cache",
      "pocodex",
      "26.313.5234.0__prod__5234",
      "__webview",
    );
    await mkdir(join(webviewRoot, "assets"), { recursive: true });
    await writeFile(join(webviewRoot, ".complete"), "ok", "utf8");
    await writeFile(join(webviewRoot, "index.html"), "<html>cached</html>", "utf8");
    await writeFile(
      join(webviewRoot, "assets", "use-auth-test.js"),
      "function T(){let e=(0,p.useContext)(m);if(!e)throw Error(`useAuth must be used within AuthProvider`);return e}function E(e){return D(s(e))}const auth={accountId:null,userId:null};",
      "utf8",
    );

    const bundle = await loadCodexBundle(appPath);

    expect(bundle.webviewRoot).toBe(webviewRoot);
    await expect(
      readFile(join(webviewRoot, "assets", "use-auth-test.js"), "utf8"),
    ).resolves.toContain(
      'window.electronBridge?.getSharedObjectSnapshotValue?.("pocodex_auth_state")',
    );
    await expect(
      readFile(join(webviewRoot, "assets", "use-auth-test.js"), "utf8"),
    ).resolves.toContain("email:e.email??t.email??null");
    await expect(readFile(join(webviewRoot, ".pocodex-webview-patches-v1"), "utf8")).resolves.toBe(
      "ok",
    );
  });

  it("separates cached artifacts for builds that share a version string", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "pocodex-home-"));
    tempDirs.push(homeDirectory);
    process.env.HOME = homeDirectory;

    const firstAppPath = await createWindowsInstallLayout({
      cliContents: "#!/bin/sh\nexit 10\n",
      packageJson: {
        version: "26.313.5234.0",
        codexBuildFlavor: "prod",
        codexBuildNumber: "5234",
      },
    });
    const secondAppPath = await createWindowsInstallLayout({
      cliContents: "#!/bin/sh\nexit 20\n",
      packageJson: {
        version: "26.313.5234.0",
        codexBuildFlavor: "prod",
        codexBuildNumber: "5235",
      },
    });
    await chmod(join(firstAppPath, "resources", "codex"), 0o644);
    await chmod(join(secondAppPath, "resources", "codex"), 0o644);

    const firstStagedCliPath = await ensureCodexCliBinary(firstAppPath);
    const secondStagedCliPath = await ensureCodexCliBinary(secondAppPath);

    expect(firstStagedCliPath).not.toBe(secondStagedCliPath);
    await expect(readFile(firstStagedCliPath, "utf8")).resolves.toBe("#!/bin/sh\nexit 10\n");
    await expect(readFile(secondStagedCliPath, "utf8")).resolves.toBe("#!/bin/sh\nexit 20\n");
  });

  it("resolves POCODEX_APP_PATH when it points at the bundled cli", async () => {
    const appPath = await createWindowsInstallLayout();
    process.env.POCODEX_APP_PATH = join(appPath, "resources", "codex");

    await expect(resolveDefaultCodexAppPath()).resolves.toBe(appPath);
  });

  async function createWindowsInstallLayout(
    options: {
      cliContents?: string;
      packageJson?: {
        version?: string;
        codexBuildFlavor?: string;
        codexBuildNumber?: string;
      };
    } = {},
  ): Promise<string> {
    const rootDirectory = await mkdtemp(join(tmpdir(), "pocodex-codex-app-"));
    tempDirs.push(rootDirectory);

    const appPath = join(rootDirectory, "app");
    const resourcesDirectory = join(appPath, "resources");
    await mkdir(resourcesDirectory, { recursive: true });
    const appAsarPath = join(resourcesDirectory, "app.asar");
    await writeFile(appAsarPath, "");
    await writeFile(
      join(resourcesDirectory, "codex"),
      options.cliContents ?? "#!/bin/sh\nexit 0\n",
      "utf8",
    );
    await chmod(join(resourcesDirectory, "codex"), 0o755);
    desktopPackagesByAppAsarPath.set(appAsarPath, {
      version: "26.313.5234.0",
      codexBuildFlavor: "prod",
      codexBuildNumber: "5234",
      ...options.packageJson,
    });
    return appPath;
  }
});
