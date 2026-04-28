import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveCodexDesktopGlobalStatePath,
  loadCodexDesktopProjects,
} from "../src/lib/codex-desktop-projects.js";

describe("loadCodexDesktopProjects", () => {
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

  it("parses roots, labels, and active flags from Codex desktop state", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);

    const projectA = join(tempDirectory, "project-a");
    const projectB = join(tempDirectory, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    const statePath = join(tempDirectory, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          "electron-saved-workspace-roots": [projectA, projectB, projectA],
          "active-workspace-roots": [projectB],
          "electron-workspace-root-labels": {
            [projectA]: "Project Alpha",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await loadCodexDesktopProjects(statePath);

    expect(result).toEqual({
      found: true,
      path: statePath,
      projects: [
        {
          root: projectA,
          label: "Project Alpha",
          active: false,
          available: true,
        },
        {
          root: projectB,
          label: "project-b",
          active: true,
          available: true,
        },
      ],
    });
  });

  it("uses desktop project order before saved workspace order", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);

    const projectA = join(tempDirectory, "project-a");
    const projectB = join(tempDirectory, "project-b");
    const projectC = join(tempDirectory, "project-c");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    await mkdir(projectC, { recursive: true });

    const statePath = join(tempDirectory, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": [projectA, projectB, projectC],
        "project-order": [projectC, projectA],
      }),
      "utf8",
    );

    await expect(loadCodexDesktopProjects(statePath)).resolves.toMatchObject({
      projects: [
        {
          root: projectC,
        },
        {
          root: projectA,
        },
        {
          root: projectB,
        },
      ],
    });
  });

  it("returns an empty project list when the desktop state file is missing", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);
    const statePath = join(tempDirectory, ".codex-global-state.json");

    await expect(loadCodexDesktopProjects(statePath)).resolves.toEqual({
      found: false,
      path: statePath,
      projects: [],
    });
  });

  it("falls back to an alternate Codex home when the preferred desktop state path is missing", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);
    const windowsProfile = join(tempDirectory, "windows-profile");
    const projectRoot = join(tempDirectory, "project-a");
    await mkdir(projectRoot, { recursive: true });

    process.env.CODEX_HOME = join(tempDirectory, "missing-codex-home");
    process.env.USERPROFILE = windowsProfile;
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    const statePath = join(windowsProfile, ".codex", ".codex-global-state.json");
    await mkdir(join(windowsProfile, ".codex"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        "electron-saved-workspace-roots": [projectRoot],
      }),
      "utf8",
    );

    await expect(loadCodexDesktopProjects(deriveCodexDesktopGlobalStatePath())).resolves.toEqual({
      found: true,
      path: statePath,
      projects: [
        {
          root: projectRoot,
          label: "project-a",
          active: false,
          available: true,
        },
      ],
    });
  });

  it("normalizes WSL UNC workspace roots and deduplicates equivalent entries", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-desktop-state-"));
    tempDirs.push(tempDirectory);

    process.env.WSL_DISTRO_NAME = "Ubuntu";

    const projectA = join(tempDirectory, "project-a");
    const projectB = join(tempDirectory, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    const projectARootWsl = convertLinuxPathToWslUnc(projectA, "wsl$");
    const projectARootLocalhost = convertLinuxPathToWslUnc(projectA, "wsl.localhost");
    const projectBRootWsl = convertLinuxPathToWslUnc(projectB, "wsl$");

    const statePath = join(tempDirectory, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          "electron-saved-workspace-roots": [
            projectARootWsl,
            projectARootLocalhost,
            projectBRootWsl,
          ],
          "active-workspace-roots": [projectARootLocalhost],
          "electron-workspace-root-labels": {
            [projectARootWsl]: "Project Alpha",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(loadCodexDesktopProjects(statePath)).resolves.toEqual({
      found: true,
      path: statePath,
      projects: [
        {
          root: projectA,
          label: "Project Alpha",
          active: true,
          available: true,
        },
        {
          root: projectB,
          label: "project-b",
          active: false,
          available: true,
        },
      ],
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

function convertLinuxPathToWslUnc(path: string, host: "wsl$" | "wsl.localhost"): string {
  return `\\\\${host}\\Ubuntu\\${path.slice(1).replaceAll("/", "\\")}`;
}
