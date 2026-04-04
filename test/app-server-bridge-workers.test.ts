import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  describeAppServerBridge,
  createBridge,
  tempDirs,
  TEST_WORKSPACE_ROOT,
  FakeGitWorkerBridge,
  getFetchResponse,
  getFetchJsonBody,
  waitForCondition,
} from "./support/app-server-bridge-test-kit.js";

describeAppServerBridge(({ children }) => {
  it("delegates git worker messages through the desktop worker bridge", async () => {
    const gitWorkerBridge = new FakeGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge,
    });
    const workerMessages: Array<{ workerName: string; message: unknown }> = [];
    bridge.on("worker_message", (workerName, message) => {
      workerMessages.push({ workerName, message });
    });

    await bridge.sendWorkerMessage("git", {
      type: "worker-request",
      workerId: "git",
      request: {
        id: "worker-1",
        method: "stable-metadata",
        params: {
          cwd: TEST_WORKSPACE_ROOT,
        },
      },
    });

    expect(gitWorkerBridge.sentMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: "worker-1",
          method: "stable-metadata",
          params: {
            cwd: TEST_WORKSPACE_ROOT,
          },
        },
      },
    ]);

    gitWorkerBridge.emit("message", {
      type: "worker-response",
      workerId: "git",
      response: {
        id: "worker-1",
        method: "stable-metadata",
        result: {
          type: "ok",
          value: {
            commonDir: "/repo/.git",
            root: "/repo",
          },
        },
      },
    });

    expect(workerMessages).toEqual([
      {
        workerName: "git",
        message: {
          type: "worker-response",
          workerId: "git",
          response: {
            id: "worker-1",
            method: "stable-metadata",
            result: {
              type: "ok",
              value: {
                commonDir: "/repo/.git",
                root: "/repo",
              },
            },
          },
        },
      },
    ]);

    expect(gitWorkerBridge.closeCalls).toBe(0);
    await bridge.close();
    expect(gitWorkerBridge.closeCalls).toBe(1);
  });

  it("routes codex apply-patch fetches through the desktop worker bridge", async () => {
    const gitWorkerBridge = new FakeGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const body = {
      cwd: TEST_WORKSPACE_ROOT,
      diff: "diff --git a/README.md b/README.md\n",
      revert: true,
      target: "unstaged",
    };

    const forwardPromise = bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-apply-patch",
      method: "POST",
      url: "vscode://codex/apply-patch",
      body: JSON.stringify(body),
    });

    await waitForCondition(() => gitWorkerBridge.sentMessages.length === 1);

    expect(gitWorkerBridge.sentMessages).toHaveLength(1);
    expect(gitWorkerBridge.sentMessages[0]).toMatchObject({
      type: "worker-request",
      workerId: "git",
      request: {
        method: "apply-patch",
        params: body,
      },
    });

    const workerRequest = gitWorkerBridge.sentMessages[0] as {
      request: {
        id: string;
      };
    };

    gitWorkerBridge.emit("message", {
      type: "worker-response",
      workerId: "git",
      response: {
        id: workerRequest.request.id,
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

    await forwardPromise;
    await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-apply-patch")));

    expect(getFetchResponse(emittedMessages, "fetch-apply-patch")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-apply-patch",
      responseType: "success",
      status: 200,
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-apply-patch")).toEqual({
      status: "success",
      appliedPaths: ["README.md"],
      skippedPaths: [],
      conflictedPaths: [],
    });

    await bridge.close();
  });

  it("cancels codex apply-patch fetches through the desktop worker bridge", async () => {
    const gitWorkerBridge = new FakeGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    const body = {
      cwd: TEST_WORKSPACE_ROOT,
      diff: "diff --git a/README.md b/README.md\n",
      revert: true,
      target: "unstaged",
    };

    const forwardPromise = bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-apply-patch-cancel",
      method: "POST",
      url: "vscode://codex/apply-patch",
      body: JSON.stringify(body),
    });

    await waitForCondition(() => gitWorkerBridge.sentMessages.length === 1);

    const workerRequest = gitWorkerBridge.sentMessages[0] as {
      request: {
        id: string;
      };
    };

    await bridge.forwardBridgeMessage({
      type: "cancel-fetch",
      requestId: "fetch-apply-patch-cancel",
    });

    await forwardPromise;
    await waitForCondition(() => gitWorkerBridge.sentMessages.length === 2);

    expect(gitWorkerBridge.sentMessages[1]).toEqual({
      type: "worker-request-cancel",
      workerId: "git",
      id: workerRequest.request.id,
    });

    gitWorkerBridge.emit("message", {
      type: "worker-response",
      workerId: "git",
      response: {
        id: workerRequest.request.id,
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

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getFetchResponse(emittedMessages, "fetch-apply-patch-cancel")).toBeUndefined();

    await bridge.close();
  });

  it("delegates git worker subscriptions to the desktop worker bridge", async () => {
    const gitWorkerBridge = new FakeGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge,
    });

    await bridge.subscribeWorker("git");
    await bridge.unsubscribeWorker("git");
    await bridge.subscribeWorker("not-supported");

    expect(gitWorkerBridge.subscriptions).toEqual(["subscribe", "unsubscribe"]);

    await bridge.close();
  });

  it("sanitizes desktop-specific thread resume params before forwarding", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-thread-resume-"));
    tempDirs.push(tempDirectory);
    const missingThreadPath = join(tempDirectory, "missing-thread.jsonl");

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "resume-1",
        method: "thread/resume",
        params: {
          threadId: "thr_123",
          cwd: TEST_WORKSPACE_ROOT,
          config: {
            analytics: "",
          },
          path: missingThreadPath,
          history: null,
          modelProvider: "codex_vscode_copilot",
          sandbox: "workspace-write",
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/resume"');
    expect(forwarded).toContain('"threadId":"thr_123"');
    expect(forwarded).toContain(`"cwd":"${TEST_WORKSPACE_ROOT}"`);
    expect(forwarded).not.toContain('"config"');
    expect(forwarded).not.toContain('"modelProvider"');
    expect(forwarded).not.toContain('"path"');

    await bridge.close();
  });

  it("preserves an existing local thread resume path", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-thread-resume-"));
    tempDirs.push(tempDirectory);
    const threadPath = join(tempDirectory, "thread.jsonl");
    await writeFile(threadPath, '{"type":"thread"}\n', "utf8");

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "resume-2",
        method: "thread/resume",
        params: {
          threadId: "thr_123",
          path: threadPath,
          cwd: TEST_WORKSPACE_ROOT,
          modelProvider: "codex_vscode_copilot",
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/resume"');
    expect(forwarded).toContain('"threadId":"thr_123"');
    expect(forwarded).toContain(`"path":"${threadPath}"`);
    expect(forwarded).not.toContain('"modelProvider"');

    await bridge.close();
  });

  it("drops desktop config from thread start params before forwarding", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "start-1",
        method: "thread/start",
        params: {
          cwd: TEST_WORKSPACE_ROOT,
          model: "gpt-5.4",
          modelProvider: "codex_vscode_copilot",
          config: {
            analytics: "",
            model: "gpt-5.4",
          },
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/start"');
    expect(forwarded).toContain(`"cwd":"${TEST_WORKSPACE_ROOT}"`);
    expect(forwarded).toContain('"model":"gpt-5.4"');
    expect(forwarded).not.toContain('"config"');
    expect(forwarded).not.toContain('"modelProvider"');

    await bridge.close();
  });

  it("preserves the model from config when sanitizing thread start params", async () => {
    const bridge = await createBridge(children);
    const child = children.at(0);

    await bridge.forwardBridgeMessage({
      type: "mcp-request",
      request: {
        id: "start-2",
        method: "thread/start",
        params: {
          cwd: TEST_WORKSPACE_ROOT,
          config: {
            analytics: "",
            model: "gpt-5.4",
          },
        },
      },
    });

    const forwarded = child?.writes ?? "";
    expect(forwarded).toContain('"method":"thread/start"');
    expect(forwarded).toContain(`"cwd":"${TEST_WORKSPACE_ROOT}"`);
    expect(forwarded).toContain('"model":"gpt-5.4"');
    expect(forwarded).not.toContain('"config"');

    await bridge.close();
  });
});
