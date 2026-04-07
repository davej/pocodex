import { describe, expect, it } from "vitest";

import { buildTrayMenuTemplate } from "../apps/tray/src/menu.js";
import { getDefaultTrayConfig } from "../apps/tray/src/config.js";
import type { TrayMenuHandlers } from "../apps/tray/src/menu.js";
import type { PocodexSnapshot } from "../src/index.js";

describe("buildTrayMenuTemplate", () => {
  const handlers: TrayMenuHandlers = {
    chooseCodexApp: () => {},
    copyLanUrl: () => {},
    copyLocalUrl: () => {},
    openPocodex: () => {},
    quit: () => {},
    regenerateAccessToken: () => {},
    resetCodexAppPath: () => {},
    restartPocodex: () => {},
    revealConfigFile: () => {},
    setLanAccess: () => {},
    startPocodex: () => {},
    stopPocodex: () => {},
  };

  it("builds the running menu with stop and LAN actions", () => {
    const template = buildTrayMenuTemplate(
      {
        ...getDefaultTrayConfig(),
        listenMode: "lan",
        token: "secret",
      },
      createSnapshot({
        localOpenUrl: "http://127.0.0.1:4321/?token=secret",
        localUrl: "http://127.0.0.1:4321/",
        networkOpenUrl: "http://192.168.1.24:4321/?token=secret",
        networkUrl: "http://192.168.1.24:4321/",
        state: "running",
        tokenConfigured: true,
      }),
      handlers,
    );

    expect(readLabels(template)).toContain("Status: running");
    expect(readLabels(template)).toContain("LAN URL: http://192.168.1.24:4321/");
    expect(readLabels(template)).toContain("Copy LAN URL");
    expect(readLabels(template)).toContain("Regenerate Access Token");
    expect(readLabels(template)).toContain("Stop Pocodex");
    expect(readLabels(template)).not.toContain("Start Pocodex");
  });

  it("builds the starting menu with a disabled starting action row", () => {
    const template = buildTrayMenuTemplate(
      getDefaultTrayConfig(),
      createSnapshot({
        state: "starting",
      }),
      handlers,
    );

    expect(readLabels(template)).toContain("Status: starting");
    expect(readLabels(template)).toContain("Starting Pocodex...");
  });

  it("builds the error menu with restart and start affordances", () => {
    const template = buildTrayMenuTemplate(
      getDefaultTrayConfig(),
      createSnapshot({
        lastError: "Codex bundle missing",
        state: "error",
      }),
      handlers,
    );

    expect(readLabels(template)).toContain("Status: error");
    expect(readLabels(template)).toContain("Last error: Codex bundle missing");
    expect(readLabels(template)).toContain("Restart Pocodex");
    expect(readLabels(template)).toContain("Start Pocodex");
  });
});

function createSnapshot(overrides: Partial<PocodexSnapshot>): PocodexSnapshot {
  return {
    appPath: "/Applications/Codex.app",
    codexVersion: "1.2.3",
    lastError: null,
    listenHost: "127.0.0.1",
    listenPort: 4321,
    localOpenUrl: "http://127.0.0.1:4321/",
    localUrl: "http://127.0.0.1:4321/",
    networkOpenUrl: null,
    networkUrl: null,
    state: "stopped",
    tokenConfigured: false,
    ...overrides,
  };
}

function readLabels(
  template: Array<{
    label?: string;
  }>,
): string[] {
  return template.flatMap((item) => (item.label ? [item.label] : []));
}
