import { afterEach, describe, expect, it } from "vitest";

import { deriveCodexHomePath } from "../src/lib/codex-home.js";

describe("deriveCodexHomePath", () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalWslDistroName = process.env.WSL_DISTRO_NAME;
  const originalWslInterop = process.env.WSL_INTEROP;

  afterEach(() => {
    restoreEnv("CODEX_HOME", originalCodexHome);
    restoreEnv("USERPROFILE", originalUserProfile);
    restoreEnv("WSL_DISTRO_NAME", originalWslDistroName);
    restoreEnv("WSL_INTEROP", originalWslInterop);
  });

  it("prefers CODEX_HOME when it is configured", () => {
    process.env.CODEX_HOME = "/tmp/custom-codex-home";
    process.env.USERPROFILE = "/mnt/c/Users/tester";
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    expect(deriveCodexHomePath()).toBe("/tmp/custom-codex-home");
  });

  it("falls back to the Windows profile inside WSL", () => {
    delete process.env.CODEX_HOME;
    process.env.USERPROFILE = "/mnt/c/Users/tester";
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    expect(deriveCodexHomePath()).toBe("/mnt/c/Users/tester/.codex");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
