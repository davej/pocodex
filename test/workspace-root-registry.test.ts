import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveWorkspaceRootRegistryPath,
  loadWorkspaceRootRegistry,
  saveWorkspaceRootRegistry,
} from "../src/lib/workspace-root-registry.js";

describe("loadWorkspaceRootRegistry", () => {
  const tempDirs: string[] = [];
  const originalCodexHome = process.env.CODEX_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalWslDistroName = process.env.WSL_DISTRO_NAME;
  const originalWslInterop = process.env.WSL_INTEROP;

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    restoreEnv("CODEX_HOME", originalCodexHome);
    restoreEnv("USERPROFILE", originalUserProfile);
    restoreEnv("WSL_DISTRO_NAME", originalWslDistroName);
    restoreEnv("WSL_INTEROP", originalWslInterop);
  });

  it("falls back to an existing alternate Codex home", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-workspace-roots-"));
    tempDirs.push(tempDirectory);

    const windowsProfile = join(tempDirectory, "windows-profile");
    const fallbackRegistryPath = join(windowsProfile, ".codex", "pocodex", "workspace-roots.json");

    process.env.CODEX_HOME = join(tempDirectory, "missing-codex-home");
    process.env.USERPROFILE = windowsProfile;
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    await saveWorkspaceRootRegistry(fallbackRegistryPath, {
      roots: ["/root/repos/xigbclutchix/BlockJsGame"],
      labels: {
        "/root/repos/xigbclutchix/BlockJsGame": "BlockJsGame",
      },
      activeRoot: "/root/repos/xigbclutchix/BlockJsGame",
      desktopImportPromptSeen: false,
    });

    await expect(loadWorkspaceRootRegistry(deriveWorkspaceRootRegistryPath())).resolves.toEqual({
      found: true,
      path: fallbackRegistryPath,
      state: {
        roots: ["/root/repos/xigbclutchix/BlockJsGame"],
        labels: {
          "/root/repos/xigbclutchix/BlockJsGame": "BlockJsGame",
        },
        activeRoot: "/root/repos/xigbclutchix/BlockJsGame",
        desktopImportPromptSeen: false,
      },
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
