import { describe, expect, it } from "vitest";

import { normalizeCliArgv } from "../src/lib/cli-args.js";

describe("normalizeCliArgv", () => {
  it("drops a leading package-manager separator", () => {
    expect(normalizeCliArgv(["--", "--app", "/Applications/Codex.app"])).toEqual([
      "--app",
      "/Applications/Codex.app",
    ]);
  });

  it("drops a separator after the serve subcommand", () => {
    expect(normalizeCliArgv(["serve", "--", "--listen", "0.0.0.0:8787"])).toEqual([
      "serve",
      "--listen",
      "0.0.0.0:8787",
    ]);
  });

  it("leaves regular argv untouched", () => {
    expect(normalizeCliArgv(["--dev", "--listen", "127.0.0.1:8787"])).toEqual([
      "--dev",
      "--listen",
      "127.0.0.1:8787",
    ]);
  });
});
