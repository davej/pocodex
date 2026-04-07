import { describe, expect, it } from "vitest";

import { shouldInitTodesktopRuntime } from "../apps/tray/src/todesktop-runtime.js";

describe("shouldInitTodesktopRuntime", () => {
  it("skips ToDesktop runtime during unpackaged local development", () => {
    expect(
      shouldInitTodesktopRuntime({
        enableRuntimeEnv: undefined,
        isPackaged: false,
        smokeTestEnv: undefined,
      }),
    ).toBe(false);
  });

  it("enables ToDesktop runtime for packaged builds", () => {
    expect(
      shouldInitTodesktopRuntime({
        enableRuntimeEnv: undefined,
        isPackaged: true,
        smokeTestEnv: undefined,
      }),
    ).toBe(true);
  });

  it("does not enable ToDesktop runtime from leaked smoke-test env alone", () => {
    expect(
      shouldInitTodesktopRuntime({
        enableRuntimeEnv: undefined,
        isPackaged: false,
        smokeTestEnv: "true",
      }),
    ).toBe(false);
  });

  it("enables ToDesktop runtime for explicit unpackaged smoke tests", () => {
    expect(
      shouldInitTodesktopRuntime({
        enableRuntimeEnv: "true",
        isPackaged: false,
        smokeTestEnv: "1",
      }),
    ).toBe(true);
  });
});
