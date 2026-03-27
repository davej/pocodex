import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  derivePersistedAtomRegistryPath,
  loadPersistedAtomRegistry,
  savePersistedAtomRegistry,
} from "../src/lib/persisted-atom-registry.js";

describe("loadPersistedAtomRegistry", () => {
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
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-persisted-atoms-"));
    tempDirs.push(tempDirectory);

    const windowsProfile = join(tempDirectory, "windows-profile");
    const fallbackRegistryPath = join(windowsProfile, ".codex", "pocodex", "persisted-atoms.json");

    process.env.CODEX_HOME = join(tempDirectory, "missing-codex-home");
    process.env.USERPROFILE = windowsProfile;
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    await savePersistedAtomRegistry(fallbackRegistryPath, {
      "enter-behavior": "newline",
      "agent-mode": "full-access",
    });

    await expect(loadPersistedAtomRegistry(derivePersistedAtomRegistryPath())).resolves.toEqual({
      found: true,
      path: fallbackRegistryPath,
      state: {
        "enter-behavior": "newline",
        "agent-mode": "full-access",
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
