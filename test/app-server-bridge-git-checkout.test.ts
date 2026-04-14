import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  describeAppServerBridge,
  createBridge,
  getFetchResponse,
  getFetchJsonBody,
  tempDirs,
  waitForCondition,
} from "./support/app-server-bridge-test-kit.js";

describeAppServerBridge(({ children }) => {
  it("checks out a branch for codex host fetch requests", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-checkout-"));
    tempDirs.push(tempDirectory);
    const { repoRoot, branchName } = await createGitCheckoutFixture(tempDirectory);
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-git-checkout-branch",
      method: "POST",
      url: "vscode://codex/git-checkout-branch",
      body: JSON.stringify({
        cwd: repoRoot,
        branch: branchName,
        hostId: "local",
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-git-checkout-branch")),
    );

    expect(getFetchResponse(emittedMessages, "fetch-git-checkout-branch")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-git-checkout-branch",
      responseType: "success",
      status: 200,
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-git-checkout-branch")).toEqual({
      status: "success",
    });
    expect(await readCurrentBranch(repoRoot)).toBe(branchName);

    await bridge.close();
  });

  it("returns structured working tree conflicts for git checkout host fetches", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-checkout-"));
    tempDirs.push(tempDirectory);
    const { repoRoot, branchName } = await createGitCheckoutFixture(tempDirectory, {
      dirtyWorkingTree: true,
    });
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-git-checkout-branch-conflict",
      method: "POST",
      url: "vscode://codex/git-checkout-branch",
      body: JSON.stringify({
        cwd: repoRoot,
        branch: branchName,
        hostId: "local",
      }),
    });

    await waitForCondition(() =>
      Boolean(getFetchResponse(emittedMessages, "fetch-git-checkout-branch-conflict")),
    );

    expect(getFetchResponse(emittedMessages, "fetch-git-checkout-branch-conflict")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-git-checkout-branch-conflict",
      responseType: "success",
      status: 200,
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-git-checkout-branch-conflict")).toEqual({
      status: "error",
      error: "Your working tree has changes that would be overwritten by checkout.",
      errorType: "blocked-by-working-tree-changes",
      conflictedPaths: ["README.md"],
      execOutput: {
        command: `git checkout --quiet ${branchName}`,
        output: expect.stringContaining("README.md"),
      },
    });
    expect(await readCurrentBranch(repoRoot)).toBe("main");

    await bridge.close();
  });
});

async function createGitCheckoutFixture(
  tempDirectory: string,
  options: {
    dirtyWorkingTree?: boolean;
  } = {},
): Promise<{ repoRoot: string; branchName: string }> {
  const repoRoot = join(tempDirectory, "repo");
  const branchName = "feature/test-branch";
  await runGitCommand(tempDirectory, ["init", "-q", "-b", "main", repoRoot]);
  await runGitCommand(repoRoot, ["config", "user.name", "Pocodex Test"]);
  await runGitCommand(repoRoot, ["config", "user.email", "pocodex@example.com"]);
  await writeFile(join(repoRoot, "README.md"), "main\n", "utf8");
  await runGitCommand(repoRoot, ["add", "README.md"]);
  await runGitCommand(repoRoot, ["commit", "-q", "-m", "initial"]);
  await runGitCommand(repoRoot, ["checkout", "-q", "-b", branchName]);
  await writeFile(join(repoRoot, "README.md"), "feature branch\n", "utf8");
  await runGitCommand(repoRoot, ["commit", "-am", "feature change"]);
  await runGitCommand(repoRoot, ["checkout", "-q", "main"]);
  if (options.dirtyWorkingTree) {
    await writeFile(join(repoRoot, "README.md"), "dirty main\n", "utf8");
  }
  return { repoRoot, branchName };
}

async function readCurrentBranch(repoRoot: string): Promise<string> {
  return runGitCommand(repoRoot, ["branch", "--show-current"]);
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  });
}
