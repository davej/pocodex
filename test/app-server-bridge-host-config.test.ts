import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLocalHostConfig, resolveLocalHostKind } from "../src/lib/app-server-bridge.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local host config helpers", () => {
  it("builds host config for git-backed workspaces", () => {
    expect(buildLocalHostConfig("workspace", "git")).toEqual({
      id: "workspace",
      display_name: "Local",
      kind: "git",
    });
  });

  it("detects whether a workspace is git-backed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocodex-host-kind-"));
    tempDirectories.push(directory);

    await expect(resolveLocalHostKind(directory)).resolves.toBe("local");

    execFileSync("git", ["init", "-q"], { cwd: directory });

    await expect(resolveLocalHostKind(directory)).resolves.toBe("git");
  });
});
