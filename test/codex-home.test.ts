import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execFileSync } from "node:child_process";

import { deriveBrowserCodexHomePath, deriveCodexHomePath } from "../src/lib/codex-home.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

describe("deriveCodexHomePath", () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalWslDistroName = process.env.WSL_DISTRO_NAME;
  const originalWslInterop = process.env.WSL_INTEROP;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

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

  it("normalizes Windows-style Codex home paths inside WSL", () => {
    process.env.CODEX_HOME = "C:\\Users\\tester\\.codex";
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    expect(deriveCodexHomePath()).toBe("/mnt/c/Users/tester/.codex");
  });

  it("falls back to the Windows user profile command inside WSL", () => {
    delete process.env.CODEX_HOME;
    delete process.env.USERPROFILE;
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === "cmd.exe") {
        return "C:\\Users\\tester\r\n";
      }
      throw new Error("unexpected command");
    });

    expect(deriveCodexHomePath()).toBe("/mnt/c/Users/tester/.codex");
  });
});

describe("deriveBrowserCodexHomePath", () => {
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

  it("returns a shared browser codex home inside WSL", () => {
    delete process.env.CODEX_HOME;
    process.env.USERPROFILE = "/mnt/c/Users/tester";
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    expect(deriveBrowserCodexHomePath()).toBe("/");
  });

  it("preserves the configured codex home inside WSL", () => {
    process.env.CODEX_HOME = "/tmp/custom-codex-home";
    process.env.USERPROFILE = "/mnt/c/Users/tester";
    process.env.WSL_DISTRO_NAME = "Ubuntu";

    expect(deriveBrowserCodexHomePath()).toBe("/tmp/custom-codex-home");
  });

  it("preserves the configured codex home outside WSL", () => {
    process.env.CODEX_HOME = "/tmp/custom-codex-home";
    delete process.env.USERPROFILE;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;

    expect(deriveBrowserCodexHomePath()).toBe("/tmp/custom-codex-home");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
