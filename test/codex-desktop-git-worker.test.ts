import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { DefaultCodexDesktopGitWorkerBridge } from "../src/lib/codex-desktop-git-worker.js";

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];

  readonly workerPath: string;
  readonly options: unknown;
  readonly postedMessages: unknown[] = [];
  terminated = false;
  unrefCalled = false;

  constructor(workerPath: string, options: unknown) {
    super();
    this.workerPath = workerPath;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  unref(): void {
    this.unrefCalled = true;
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

describe("DefaultCodexDesktopGitWorkerBridge", () => {
  afterEach(() => {
    FakeWorker.instances = [];
  });

  it("spawns the desktop worker lazily and forwards git messages", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
      codexAppSessionId: "session-1",
    });

    expect(FakeWorker.instances).toHaveLength(0);

    await bridge.send({
      type: "worker-request",
      workerId: "git",
      request: {
        id: "req-1",
        method: "status-summary",
      },
    });

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.workerPath).toBe("/tmp/pocodex-worker.js");
    expect(FakeWorker.instances[0]?.unrefCalled).toBe(true);
    expect(FakeWorker.instances[0]?.postedMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: "req-1",
          method: "status-summary",
        },
      },
    ]);
    expect(FakeWorker.instances[0]?.options).toMatchObject({
      name: "git",
      workerData: {
        workerId: "git",
        maxLogLevel: "warning",
        sentryRewriteFramesRoot: "/Applications/Codex.app",
        spawnInsideWsl: false,
        sentryInitOptions: {
          buildFlavor: "stable",
          buildNumber: "123",
          appVersion: "1.2.3",
          codexAppSessionId: "session-1",
        },
      },
    });

    await bridge.close();
  });

  it("responds to worktree cleanup main RPC requests with a safe stub", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
      codexAppSessionId: "session-1",
    });

    await bridge.subscribe();

    const worker = FakeWorker.instances[0];
    worker?.emit("message", {
      type: "worker-main-rpc-request",
      workerId: "git",
      requestId: "rpc-1",
      method: "worktree-cleanup-inputs",
      params: {
        hostKey: "local",
        threadIds: ["thr_1", "thr_2"],
      },
    });

    expect(worker?.postedMessages.at(-1)).toMatchObject({
      type: "worker-main-rpc-response",
      workerId: "git",
      requestId: "rpc-1",
      method: "worktree-cleanup-inputs",
      result: {
        type: "ok",
        value: {
          pinnedThreadIds: [],
          protectPreMigrationOwnerlessWorktrees: false,
          autoCleanupEnabled: false,
          keepCount: 0,
          threadMetadataById: {
            thr_1: {
              isInProgress: true,
            },
            thr_2: {
              isInProgress: true,
            },
          },
        },
      },
    });

    await bridge.close();
  });

  it("supports the platform-family main RPC method used by current desktop workers", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });

    await bridge.subscribe();

    const worker = FakeWorker.instances[0];
    worker?.emit("message", {
      type: "worker-main-rpc-request",
      workerId: "git",
      requestId: "rpc-platform-family",
      method: "platform-family",
    });

    expect(worker?.postedMessages.at(-1)).toEqual({
      type: "worker-main-rpc-response",
      workerId: "git",
      requestId: "rpc-platform-family",
      method: "platform-family",
      result: {
        type: "ok",
        value: process.platform === "win32" ? "windows" : "unix",
      },
    });

    await bridge.close();
  });

  it("returns an explicit error for unknown main RPC methods", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });

    await bridge.subscribe();

    const worker = FakeWorker.instances[0];
    worker?.emit("message", {
      type: "worker-main-rpc-request",
      workerId: "git",
      requestId: "rpc-2",
      method: "unknown-method",
    });

    expect(worker?.postedMessages.at(-1)).toEqual({
      type: "worker-main-rpc-response",
      workerId: "git",
      requestId: "rpc-2",
      method: "unknown-method",
      result: {
        type: "error",
        error: {
          message: 'Unsupported git worker main RPC method "unknown-method" in Pocodex.',
        },
      },
    });

    await bridge.close();
  });

  it("supports the current desktop worker file-system main RPC methods", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-worker-"));

    try {
      await bridge.subscribe();

      const worker = FakeWorker.instances[0];
      const nestedDirectory = join(tempDirectory, "nested");
      const filePath = join(nestedDirectory, "file.txt");
      const copiedFilePath = join(nestedDirectory, "copied.txt");

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-create-dir",
        method: "fs-create-directory",
        params: {
          path: nestedDirectory,
          recursive: true,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-create-dir")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-create-directory",
        result: {
          type: "ok",
          value: null,
        },
      });

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-write-file",
        method: "fs-write-file",
        params: {
          path: filePath,
          dataBase64: Buffer.from("hello from pocodex", "utf8").toString("base64"),
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-write-file")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-write-file",
        result: {
          type: "ok",
          value: null,
        },
      });
      await expect(readFile(filePath, "utf8")).resolves.toBe("hello from pocodex");

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-read-file",
        method: "fs-read-file",
        params: {
          path: filePath,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-read-file")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-read-file",
        result: {
          type: "ok",
          value: {
            dataBase64: Buffer.from("hello from pocodex", "utf8").toString("base64"),
          },
        },
      });

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-metadata",
        method: "fs-get-metadata",
        params: {
          path: filePath,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-metadata")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-get-metadata",
        result: {
          type: "ok",
          value: {
            isDirectory: false,
            isFile: true,
          },
        },
      });

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-read-dir",
        method: "fs-read-directory",
        params: {
          path: nestedDirectory,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-read-dir")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-read-directory",
        result: {
          type: "ok",
          value: {
            entries: [
              {
                fileName: "file.txt",
                isDirectory: false,
                isFile: true,
              },
            ],
          },
        },
      });

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-copy-file",
        method: "fs-copy",
        params: {
          sourcePath: filePath,
          destinationPath: copiedFilePath,
          recursive: false,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-copy-file")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-copy",
        result: {
          type: "ok",
          value: null,
        },
      });
      await expect(readFile(copiedFilePath, "utf8")).resolves.toBe("hello from pocodex");

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-remove-file",
        method: "fs-remove",
        params: {
          path: copiedFilePath,
          recursive: false,
          force: true,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-remove-file")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "fs-remove",
        result: {
          type: "ok",
          value: null,
        },
      });
      await expect(stat(copiedFilePath)).rejects.toThrow(/ENOENT|no such file/i);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("supports the current desktop worker command exec main RPC methods", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });

    try {
      await bridge.subscribe();

      const worker = FakeWorker.instances[0];
      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-command-start",
        method: "command-exec-start",
        params: {
          processId: "proc-1",
          command: [
            process.execPath,
            "-e",
            "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1000);",
          ],
          streamStdoutStderr: true,
          disableTimeout: true,
        },
      });

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-command-write",
        method: "command-exec-write",
        params: {
          processId: "proc-1",
          delta: Uint8Array.from(Buffer.from("hello from stdin", "utf8")),
          closeStdin: false,
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-command-write")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "command-exec-write",
        result: {
          type: "ok",
          value: null,
        },
      });

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-command-resize",
        method: "command-exec-resize",
        params: {
          processId: "proc-1",
          size: {
            cols: 80,
            rows: 24,
          },
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-command-resize")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "command-exec-resize",
        result: {
          type: "ok",
          value: null,
        },
      });

      const stdoutEvent = await waitForWorkerEvent(worker, (message) => {
        if (!isCommandExecOutputEvent(message, "proc-1", "stdout")) {
          return false;
        }
        return decodeDeltaChunk(message).includes("hello from stdin");
      });
      expect(decodeDeltaChunk(stdoutEvent)).toContain("hello from stdin");

      worker?.emit("message", {
        type: "worker-main-rpc-request",
        workerId: "git",
        requestId: "rpc-command-terminate",
        method: "command-exec-terminate",
        params: {
          processId: "proc-1",
        },
      });
      expect(await waitForPostedMessage(worker, "rpc-command-terminate")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "command-exec-terminate",
        result: {
          type: "ok",
          value: null,
        },
      });

      expect(await waitForPostedMessage(worker, "rpc-command-start")).toMatchObject({
        type: "worker-main-rpc-response",
        method: "command-exec-start",
        result: {
          type: "ok",
          value: {
            exitCode: null,
          },
        },
      });
    } finally {
      await bridge.close();
    }
  });

  it("handles apply-patch locally for unstaged revert requests", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = [
      "# Pocodex",
      "",
      "It serves the real Codex desktop webview from the installed app bundle.",
      "",
    ].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        [
          "# Pocodex",
          "",
          "It serves the real Codex desktop webview from the installed app bundle.",
          "",
          "> Warning",
          "> This project is heavily vibe coded.",
          "",
        ].join("\n"),
        "utf8",
      );
      const diff = execFileSync("git", ["diff", "--", "README.md"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(originalContents);
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("reports applied paths for hunk-only unstaged revert requests", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-hunk-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = [
      "# Pocodex",
      "",
      "It serves the real Codex desktop webview from the installed app bundle.",
      "",
      '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
      "",
    ].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        [
          "# Pocodex",
          "",
          "It serves the real Codex desktop webview from the installed app bundle.",
          "",
          "> Warning",
          "> Temporary hunk-revert repro marker.",
          "",
          '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
          "",
        ].join("\n"),
        "utf8",
      );
      const fullDiff = execFileSync("git", ["diff", "--", "README.md"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });
      const hunkOnlyDiff = fullDiff.replace(/^index .*$/m, "");
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-hunk-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-hunk-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff: hunkOnlyDiff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-hunk-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(originalContents);
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("handles file-header hunk revert requests without diff metadata", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-file-header-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = [
      "# Pocodex",
      "",
      "It serves the real Codex desktop webview from the installed app bundle.",
      "",
      '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
      "",
    ].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        [
          "# Pocodex",
          "",
          "It serves the real Codex desktop webview from the installed app bundle.",
          "",
          "> Warning",
          "> Temporary header-only hunk-revert repro marker.",
          "",
          '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
          "",
        ].join("\n"),
        "utf8",
      );
      const fullDiff = execFileSync("git", ["diff", "--", "README.md"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });
      const fileHeaderDiff = fullDiff.replace(/^diff --git .*$/m, "").replace(/^index .*$/m, "");
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-file-header-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-file-header-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff: fileHeaderDiff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-file-header-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(originalContents);
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("normalizes malformed hunk counts from persisted revert requests", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-malformed-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = [
      "# Bedrock Pack Manager",
      "",
      "## 100% Vibe Coded - Make backups!",
      "",
      "Install Minecraft Bedrock behavior packs and resource packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.",
      "All runtime data lives under `run/` so the project root stays clean.",
      "",
      "## Interactive Menu",
      "",
      "The default interactive mode opens a keyboard-driven menu for install, uninstall, rebuild, audit, cleanup, and world-edit flows.",
      "",
      "![Interactive terminal menu](docs/images/interactive-menu.png)",
      "",
    ].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        [
          "# Bedrock Pack Manager",
          "",
          "## 100% Vibe Coded - Make backups!",
          "",
          "Install Minecraft Bedrock behavior packs and resource packs into a world from `.mcaddon`, `.mcpack`, `.zip`, or already-extracted folders.",
          "All runtime data lives under `run/` so the project root stays clean.",
          "",
          "## Interactive Menu",
          "",
          "The default interactive mode opens a keyboard-driven menu for install, uninstall, rebuild, audit, cleanup, and world-edit flows.",
          "It is intended to keep the common world-management tasks fast without memorizing every flag.",
          "",
          "![Interactive terminal menu](docs/images/interactive-menu.png)",
          "",
        ].join("\n"),
        "utf8",
      );
      const malformedDiff = [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -8,6 +8,7 @@ All runtime data lives under `run/` so the project root stays clean.",
        " ## Interactive Menu",
        " ",
        " The default interactive mode opens a keyboard-driven menu for install, uninstall, rebuild, audit, cleanup, and world-edit flows.",
        "+It is intended to keep the common world-management tasks fast without memorizing every flag.",
        " ",
        " ![Interactive terminal menu](docs/images/interactive-menu.png)",
        "",
      ].join("\n");
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-malformed-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-malformed-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff: malformedDiff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-malformed-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(originalContents);
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("falls back for stale replace-only revert requests", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-replace-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = ["line1", "line2", "line3", "line4", ""].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        ["line1", "line2 replacement", "line3", "line4", ""].join("\n"),
        "utf8",
      );
      const staleDiff = execFileSync("git", ["diff", "--", "README.md"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });

      await writeFile(
        readmePath,
        ["line1 drift", "line2 replacement", "line3", "line4", ""].join("\n"),
        "utf8",
      );
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-replace-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-replace-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff: staleDiff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-replace-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(
        ["line1 drift", "line2", "line3", "line4", ""].join("\n"),
      );
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("falls back for stale unstaged revert requests when git apply cannot match drifted context", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-stale-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = ["line1", "line2", "line3", "line4", "line5", ""].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        ["line1", "line2", "added-a", "added-b", "line3", "line4", "line5", ""].join("\n"),
        "utf8",
      );
      const staleDiff = execFileSync("git", ["diff", "--", "README.md"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });

      await writeFile(
        readmePath,
        [
          "line1",
          "line2 changed",
          "added-a",
          "added-b",
          "line3",
          "line4 changed",
          "line5",
          "",
        ].join("\n"),
        "utf8",
      );
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-stale-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-stale-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff: staleDiff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-stale-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(
        ["line1", "line2 changed", "line3", "line4 changed", "line5", ""].join("\n"),
      );
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("falls back for stale unstaged revert requests when git apply produces conflicts", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-conflict-"));
    const readmePath = join(tempDirectory, "README.md");
    const originalContents = [
      '# <img src="https://i.imgur.com/ionPEb2.png" alt="Pocodex" width="300">',
      "",
      "Pocodex lets you use the Codex desktop app in a regular browser, including on your phone or any other remote device. It's like Claude Code's Remote Control, but for Codex!",
      "",
      "It serves the real Codex desktop webview from the installed app bundle, reuses the bundled `codex app-server` as the agentic harness, and adds host-side shims for the desktop functionality the UI expects.",
      "",
      '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
      "",
    ].join("\n");

    try {
      await writeFile(readmePath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "README.md"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        readmePath,
        [
          '# <img src="https://i.imgur.com/ionPEb2.png" alt="Pocodex" width="300">',
          "",
          "Pocodex lets you use the Codex desktop app in a regular browser, including remote devices like phones, tablets, and other laptops. It's like Claude Code's Remote Control, but for Codex!",
          "",
          "Temporary stale revert test line A.",
          "Temporary stale revert test line B.",
          "",
          "It serves the real Codex desktop webview from the installed app bundle, reuses the bundled `codex app-server` as the agentic harness, and adds host-side bridge shims for the desktop functionality the UI expects.",
          "",
          '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
          "",
        ].join("\n"),
        "utf8",
      );
      const staleDiff = execFileSync("git", ["diff", "--", "README.md"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });

      await writeFile(
        readmePath,
        [
          '# <img src="https://i.imgur.com/ionPEb2.png" alt="Pocodex" width="300">',
          "",
          "Pocodex lets you use the Codex desktop app in a regular browser, including remote devices like phones, tablets, laptops, and other screens. It's like Claude Code's Remote Control, but for Codex!",
          "",
          "Temporary stale revert test line A.",
          "Temporary stale revert test line B.",
          "",
          "It serves the real Codex desktop webview from the installed app bundle, reuses the bundled `codex app-server` as the agentic harness, and adds host-side bridge layers for the desktop functionality the UI expects.",
          "",
          '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
          "",
        ].join("\n"),
        "utf8",
      );
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-conflict-1");

      await bridge.send({
        type: "worker-request",
        workerId: "git",
        request: {
          id: "apply-patch-conflict-1",
          method: "apply-patch",
          params: {
            cwd: tempDirectory,
            diff: staleDiff,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
            revert: true,
            target: "unstaged",
          },
        },
      });

      expect(await responsePromise).toMatchObject({
        type: "worker-response",
        workerId: "git",
        response: {
          id: "apply-patch-conflict-1",
          method: "apply-patch",
          result: {
            type: "ok",
            value: {
              status: "success",
              appliedPaths: ["README.md"],
              skippedPaths: [],
              conflictedPaths: [],
            },
          },
        },
      });
      await expect(readFile(readmePath, "utf8")).resolves.toBe(
        [
          '# <img src="https://i.imgur.com/ionPEb2.png" alt="Pocodex" width="300">',
          "",
          "Pocodex lets you use the Codex desktop app in a regular browser, including remote devices like phones, tablets, laptops, and other screens. It's like Claude Code's Remote Control, but for Codex!",
          "",
          "It serves the real Codex desktop webview from the installed app bundle, reuses the bundled `codex app-server` as the agentic harness, and adds host-side bridge layers for the desktop functionality the UI expects.",
          "",
          '<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">',
          "",
        ].join("\n"),
      );
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("preserves skipped paths when insertion fallback only reverts one file", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-partial-"));
    const alphaPath = join(tempDirectory, "alpha.txt");
    const betaPath = join(tempDirectory, "beta.txt");
    const originalAlpha = ["alpha-1", "alpha-2", "alpha-3", "alpha-4", ""].join("\n");
    const originalBeta = ["beta-1", "beta-2", "beta-3", "beta-4", ""].join("\n");

    try {
      await writeFile(alphaPath, originalAlpha, "utf8");
      await writeFile(betaPath, originalBeta, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "alpha.txt", "beta.txt"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        alphaPath,
        ["alpha-1", "alpha-2", "alpha-extra", "alpha-3", "alpha-4", ""].join("\n"),
        "utf8",
      );
      await writeFile(
        betaPath,
        ["beta-1", "beta-2", "beta-extra", "beta-3", "beta-4", ""].join("\n"),
        "utf8",
      );
      const staleDiff = execFileSync("git", ["diff", "--", "alpha.txt", "beta.txt"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });
      const fallbackOnlyDiff = staleDiff
        .replace(/^--- a\//gm, "--- ")
        .replace(/^\+\+\+ b\//gm, "+++ ");

      await writeFile(
        alphaPath,
        ["alpha-1 drifted", "alpha-2", "alpha-extra", "alpha-3 drifted", "alpha-4", ""].join("\n"),
        "utf8",
      );
      await writeFile(
        betaPath,
        ["beta-1 drifted", "beta-2", "beta-extra drifted", "beta-3 drifted", "beta-4", ""].join(
          "\n",
        ),
        "utf8",
      );
      const originalPathEnv = process.env.PATH;
      process.env.PATH = await createGitOnlyPath(tempDirectory);
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-partial-1");

      try {
        await bridge.send({
          type: "worker-request",
          workerId: "git",
          request: {
            id: "apply-patch-partial-1",
            method: "apply-patch",
            params: {
              cwd: tempDirectory,
              diff: fallbackOnlyDiff,
              hostConfig: {
                id: "local",
                display_name: "Local",
                kind: "local",
              },
              revert: true,
              target: "unstaged",
            },
          },
        });

        expect(await responsePromise).toMatchObject({
          type: "worker-response",
          workerId: "git",
          response: {
            id: "apply-patch-partial-1",
            method: "apply-patch",
            result: {
              type: "ok",
              value: {
                status: "partial-success",
                appliedPaths: ["alpha.txt"],
                skippedPaths: ["beta.txt"],
                conflictedPaths: [],
                execOutput: {
                  command: expect.stringContaining("stale-hunk-insertion-fallback"),
                },
              },
            },
          },
        });
        await expect(readFile(alphaPath, "utf8")).resolves.toBe(
          ["alpha-1 drifted", "alpha-2", "alpha-3 drifted", "alpha-4", ""].join("\n"),
        );
        await expect(readFile(betaPath, "utf8")).resolves.toBe(
          ["beta-1 drifted", "beta-2", "beta-extra drifted", "beta-3 drifted", "beta-4", ""].join(
            "\n",
          ),
        );
        expect(FakeWorker.instances).toHaveLength(0);
      } finally {
        process.env.PATH = originalPathEnv;
      }
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("anchors stale insertion fallback to the expected hunk location", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-apply-patch-anchored-"));
    const notesPath = join(tempDirectory, "notes.txt");
    const originalContents = ["top", "before", "target", "after", "tail", ""].join("\n");

    try {
      await writeFile(notesPath, originalContents, "utf8");
      execFileSync("git", ["init", "-q"], { cwd: tempDirectory });
      execFileSync("git", ["config", "user.name", "Pocodex Test"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["config", "user.email", "pocodex@example.com"], {
        cwd: tempDirectory,
      });
      execFileSync("git", ["add", "notes.txt"], { cwd: tempDirectory });
      execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: tempDirectory });

      await writeFile(
        notesPath,
        ["top", "before", "target", "added-a", "added-b", "after", "tail", ""].join("\n"),
        "utf8",
      );
      const staleDiff = execFileSync("git", ["diff", "--", "notes.txt"], {
        cwd: tempDirectory,
        encoding: "utf8",
      });
      const fallbackOnlyDiff = staleDiff
        .replace(/^--- a\//gm, "--- ")
        .replace(/^\+\+\+ b\//gm, "+++ ");

      await writeFile(
        notesPath,
        [
          "top drifted",
          "added-a",
          "added-b",
          "before drifted",
          "target drifted",
          "added-a",
          "added-b",
          "after drifted",
          "tail drifted",
          "",
        ].join("\n"),
        "utf8",
      );
      const originalPathEnv = process.env.PATH;
      process.env.PATH = await createGitOnlyPath(tempDirectory);
      const responsePromise = waitForBridgeWorkerResponse(bridge, "apply-patch-anchored-1");

      try {
        await bridge.send({
          type: "worker-request",
          workerId: "git",
          request: {
            id: "apply-patch-anchored-1",
            method: "apply-patch",
            params: {
              cwd: tempDirectory,
              diff: fallbackOnlyDiff,
              hostConfig: {
                id: "local",
                display_name: "Local",
                kind: "local",
              },
              revert: true,
              target: "unstaged",
            },
          },
        });

        expect(await responsePromise).toMatchObject({
          type: "worker-response",
          workerId: "git",
          response: {
            id: "apply-patch-anchored-1",
            method: "apply-patch",
            result: {
              type: "ok",
              value: {
                status: "success",
                appliedPaths: ["notes.txt"],
                skippedPaths: [],
                conflictedPaths: [],
                execOutput: {
                  command: expect.stringContaining("stale-hunk-insertion-fallback"),
                },
              },
            },
          },
        });
        await expect(readFile(notesPath, "utf8")).resolves.toBe(
          [
            "top drifted",
            "added-a",
            "added-b",
            "before drifted",
            "target drifted",
            "after drifted",
            "tail drifted",
            "",
          ].join("\n"),
        );
        expect(FakeWorker.instances).toHaveLength(0);
      } finally {
        process.env.PATH = originalPathEnv;
      }
    } finally {
      await bridge.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("emits deterministic worker errors on unexpected exit and recreates the worker", async () => {
    const bridge = new DefaultCodexDesktopGitWorkerBridge({
      appPath: "/Applications/Codex.app",
      resolveWorkerScript: async () => ({
        workerPath: "/tmp/pocodex-worker.js",
        metadata: {
          appPath: "/Applications/Codex.app",
          buildFlavor: "stable",
          buildNumber: "123",
          version: "1.2.3",
        },
      }),
      WorkerClass: FakeWorker as never,
    });
    const messages: unknown[] = [];
    const errors: Error[] = [];
    bridge.on("message", (message) => {
      messages.push(message);
    });
    bridge.on("error", (error) => {
      errors.push(error);
    });

    await bridge.send({
      type: "worker-request",
      workerId: "git",
      request: {
        id: "req-9",
        method: "status-summary",
      },
    });

    const firstWorker = FakeWorker.instances[0];
    firstWorker?.emit("exit", 9);

    expect(messages).toEqual([
      {
        type: "worker-response",
        workerId: "git",
        response: {
          id: "req-9",
          method: "status-summary",
          result: {
            type: "error",
            error: {
              message: "Codex desktop git worker exited unexpectedly with code 9.",
            },
          },
        },
      },
    ]);
    expect(errors.at(-1)?.message).toBe(
      "Codex desktop git worker exited unexpectedly with code 9.",
    );

    await bridge.send({
      type: "worker-request",
      workerId: "git",
      request: {
        id: "req-10",
        method: "current-branch",
      },
    });

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]?.postedMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: "req-10",
          method: "current-branch",
        },
      },
    ]);

    await bridge.close();
  });
});

async function waitForPostedMessage(
  worker: FakeWorker | undefined,
  requestId: string,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = worker?.postedMessages.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "requestId" in entry &&
        entry.requestId === requestId,
    );
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for posted message ${requestId}`);
}

async function createGitOnlyPath(tempDirectory: string): Promise<string> {
  const gitBinary = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  const binDirectory = join(tempDirectory, "git-only-bin");
  await mkdir(binDirectory, { recursive: true });
  await symlink(gitBinary, join(binDirectory, "git"));
  return binDirectory;
}

async function waitForWorkerEvent(
  worker: FakeWorker | undefined,
  predicate: (message: unknown) => boolean,
  timeoutMs = 5_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = worker?.postedMessages.find(predicate);
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worker event");
}

async function waitForBridgeWorkerResponse(
  bridge: DefaultCodexDesktopGitWorkerBridge,
  requestId: string,
  timeoutMs = 5_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for bridge worker response ${requestId}`));
    }, timeoutMs);

    const onMessage = (message: unknown) => {
      const response =
        typeof message === "object" &&
        message !== null &&
        "response" in message &&
        typeof (message as { response?: unknown }).response === "object" &&
        (message as { response: { id?: unknown } }).response !== null
          ? (message as { response: { id?: unknown } }).response
          : null;
      if (response?.id !== requestId) {
        return;
      }
      cleanup();
      resolve(message);
    };

    const cleanup = () => {
      clearTimeout(timer);
      bridge.off("message", onMessage);
    };

    bridge.on("message", onMessage);
  });
}

function isCommandExecOutputEvent(
  value: unknown,
  processId: string,
  stream: "stdout" | "stderr",
): value is {
  params: {
    delta: {
      chunk: Uint8Array;
    };
  };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "worker-main-rpc-event" &&
    "method" in value &&
    value.method === "command-exec-output-delta" &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null &&
    "processId" in value.params &&
    value.params.processId === processId &&
    "stream" in value.params &&
    value.params.stream === stream
  );
}

function decodeDeltaChunk(value: {
  params: {
    delta: {
      chunk: Uint8Array;
    };
  };
}): string {
  return Buffer.from(value.params.delta.chunk).toString("utf8");
}
