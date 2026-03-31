import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatCodexBuildSignature,
  recordUsedCodexBuild,
  type CodexBuildSignature,
} from "../src/lib/used-codex-build.js";

describe("used-codex-build", () => {
  it("records the first used Codex build without reporting an update", async () => {
    const registryPath = await createRegistryPath();
    const currentBuild = createCodexBuild({
      version: "1.0.0",
      buildNumber: "123",
    });

    const result = await recordUsedCodexBuild(registryPath, currentBuild);

    expect(result).toEqual({
      currentBuild,
      previousBuild: null,
      isUpdated: false,
    });
    await expect(readPersistedBuild(registryPath)).resolves.toEqual(currentBuild);
  });

  it("reports when the current Codex build is newer than the stored build", async () => {
    const registryPath = await createRegistryPath();
    await writeStoredBuild(
      registryPath,
      createCodexBuild({
        version: "1.9.0",
        buildNumber: "122",
      }),
    );
    const currentBuild = createCodexBuild({
      version: "2.0.0",
      buildNumber: "123",
    });

    const result = await recordUsedCodexBuild(registryPath, currentBuild);

    expect(result).toEqual({
      currentBuild,
      previousBuild: createCodexBuild({
        version: "1.9.0",
        buildNumber: "122",
      }),
      isUpdated: true,
    });
    await expect(readPersistedBuild(registryPath)).resolves.toEqual(currentBuild);
  });

  it("updates the stored build without reporting an update when the current build is older", async () => {
    const registryPath = await createRegistryPath();
    await writeStoredBuild(
      registryPath,
      createCodexBuild({
        version: "2.0.0",
        buildNumber: "123",
      }),
    );
    const currentBuild = createCodexBuild({
      version: "1.9.0",
      buildNumber: "122",
    });

    const result = await recordUsedCodexBuild(registryPath, currentBuild);

    expect(result).toEqual({
      currentBuild,
      previousBuild: createCodexBuild({
        version: "2.0.0",
        buildNumber: "123",
      }),
      isUpdated: false,
    });
    await expect(readPersistedBuild(registryPath)).resolves.toEqual(currentBuild);
  });

  it("formats Codex builds for terminal logging", () => {
    expect(
      formatCodexBuildSignature(
        createCodexBuild({
          version: "2.0.0",
          buildFlavor: "stable",
          buildNumber: "123",
        }),
      ),
    ).toBe("2.0.0 (stable build 123)");
  });
});

function createCodexBuild(overrides: Partial<CodexBuildSignature>): CodexBuildSignature {
  return {
    version: "1.0.0",
    buildFlavor: "stable",
    buildNumber: "123",
    ...overrides,
  };
}

async function createRegistryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pocodex-used-codex-build-"));
  return join(directory, "last-used-codex-build.json");
}

async function writeStoredBuild(registryPath: string, build: CodexBuildSignature): Promise<void> {
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        codexBuild: build,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function readPersistedBuild(registryPath: string): Promise<CodexBuildSignature> {
  const raw = JSON.parse(await readFile(registryPath, "utf8")) as {
    codexBuild: CodexBuildSignature;
  };
  return raw.codexBuild;
}
