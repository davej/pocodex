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
  const originalHome = process.env.HOME;
  const originalPocodexAppPath = process.env.POCODEX_APP_PATH;

  beforeEach(() => {
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
    const versionCacheRoot = join(homeDirectory, ".cache", "pocodex", "26.313.5234.0");
    await mkdir(join(versionCacheRoot, "__cli", "windows-app"), { recursive: true });
    await writeFile(join(versionCacheRoot, "__cli", "windows-app", "codex"), "cached", "utf8");

    asarMock.listPackage.mockReturnValue(["/webview/index.html", "/webview/assets/app-test.png"]);
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

      throw new Error(`Unexpected asar extract for ${filename}`);
    });

    const bundle = await loadCodexBundle(appPath);

    expect(bundle.webviewRoot).toBe(join(versionCacheRoot, "__webview"));
    expect(bundle.faviconHref).toBe("./assets/app-test.png");
    await expect(bundle.readIndexHtml()).resolves.toBe("<html>codex</html>");
    await expect(
      readFile(join(versionCacheRoot, "__cli", "windows-app", "codex"), "utf8"),
    ).resolves.toBe("cached");
  });

  it("resolves POCODEX_APP_PATH when it points at the bundled cli", async () => {
    const appPath = await createWindowsInstallLayout();
    process.env.POCODEX_APP_PATH = join(appPath, "resources", "codex");

    await expect(resolveDefaultCodexAppPath()).resolves.toBe(appPath);
  });

  async function createWindowsInstallLayout(): Promise<string> {
    const rootDirectory = await mkdtemp(join(tmpdir(), "pocodex-codex-app-"));
    tempDirs.push(rootDirectory);

    const appPath = join(rootDirectory, "app");
    const resourcesDirectory = join(appPath, "resources");
    await mkdir(resourcesDirectory, { recursive: true });
    await writeFile(join(resourcesDirectory, "app.asar"), "");
    await writeFile(join(resourcesDirectory, "codex"), "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(join(resourcesDirectory, "codex"), 0o755);
    return appPath;
  }
});
