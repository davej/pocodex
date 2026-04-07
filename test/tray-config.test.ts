import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { chooseCodexAppPath } from "../apps/tray/src/app-path.js";
import {
  applySelectedCodexAppPath,
  buildRuntimeOptions,
  ensureTrayConfigHasToken,
  getDefaultTrayConfig,
  loadTrayConfig,
  planLanAccessChange,
  saveTrayConfig,
} from "../apps/tray/src/config.js";

describe("tray config helpers", () => {
  it("loads defaults when the config file does not exist and round-trips persisted values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocodex-tray-config-"));
    const configPath = join(directory, "config.json");

    await expect(loadTrayConfig(configPath)).resolves.toEqual(getDefaultTrayConfig());

    const savedConfig = {
      ...getDefaultTrayConfig(),
      appPath: "/Applications/Codex Beta.app",
      listenPort: 4321,
      listenMode: "lan" as const,
      token: "secret",
    };
    await saveTrayConfig(configPath, savedConfig);

    await expect(loadTrayConfig(configPath)).resolves.toEqual(savedConfig);
    await expect(readFile(configPath, "utf8")).resolves.toContain('"listenMode": "lan"');
    await expect(readFile(configPath, "utf8")).resolves.toContain('"listenPort": 4321');
  });

  it("generates a token for LAN mode changes and marks running runtimes for restart", () => {
    const result = planLanAccessChange(
      getDefaultTrayConfig(),
      {
        appPath: "/Applications/Codex.app",
        codexVersion: "1.2.3",
        lastError: null,
        listenHost: "127.0.0.1",
        listenPort: 4321,
        localOpenUrl: "http://127.0.0.1:4321/",
        localUrl: "http://127.0.0.1:4321/",
        networkOpenUrl: null,
        networkUrl: null,
        state: "running",
        tokenConfigured: false,
      },
      true,
    );

    expect(result.restartRequired).toBe(true);
    expect(result.config.listenMode).toBe("lan");
    expect(result.config.token).toMatch(/^[a-f0-9]{32}$/);
  });

  it("only updates the Codex.app path when a selection is made", async () => {
    const config = getDefaultTrayConfig();

    await expect(
      chooseCodexAppPath(async () => ({
        canceled: true,
        filePaths: [],
      })),
    ).resolves.toBeNull();
    expect(applySelectedCodexAppPath(config, null)).toBe(config);

    const selectedPath = await chooseCodexAppPath(async () => ({
      canceled: false,
      filePaths: ["/Applications/Codex Beta.app"],
    }));

    expect(applySelectedCodexAppPath(config, selectedPath)).toEqual({
      ...config,
      appPath: "/Applications/Codex Beta.app",
    });
  });

  it("ensures a stable token and carries it into loopback runtime options", () => {
    const configWithToken = ensureTrayConfigHasToken(getDefaultTrayConfig());

    expect(configWithToken.token).toMatch(/^[a-f0-9]{32}$/);
    expect(buildRuntimeOptions(configWithToken)).toMatchObject({
      listenHost: "127.0.0.1",
      listenPort: 0,
      token: configWithToken.token,
    });
  });
});
