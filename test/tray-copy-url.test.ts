import { describe, expect, it } from "vitest";

import { getClipboardUrl } from "../apps/tray/src/copy-url.js";
import type { PocodexSnapshot } from "../src/index.js";

describe("getClipboardUrl", () => {
  it("prefers the tokenized local open URL", () => {
    expect(
      getClipboardUrl(
        createSnapshot({
          localOpenUrl: "http://127.0.0.1:4321/?token=secret",
          localUrl: "http://127.0.0.1:4321/",
        }),
        "local",
      ),
    ).toBe("http://127.0.0.1:4321/?token=secret");
  });

  it("prefers the tokenized LAN open URL", () => {
    expect(
      getClipboardUrl(
        createSnapshot({
          networkOpenUrl: "http://192.168.1.24:4321/?token=secret",
          networkUrl: "http://192.168.1.24:4321/",
        }),
        "network",
      ),
    ).toBe("http://192.168.1.24:4321/?token=secret");
  });

  it("falls back to the display URL when no open URL is available", () => {
    expect(
      getClipboardUrl(
        createSnapshot({
          localOpenUrl: null,
          localUrl: "http://127.0.0.1:4321/",
        }),
        "local",
      ),
    ).toBe("http://127.0.0.1:4321/");
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
