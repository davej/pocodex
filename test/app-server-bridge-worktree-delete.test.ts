import { EventEmitter } from "node:events";

import { expect, it } from "vitest";

import {
  createBridge,
  describeAppServerBridge,
  getFetchResponse,
} from "./support/app-server-bridge-test-kit.js";

class TestGitWorkerBridge extends EventEmitter {
  readonly sentMessages: unknown[] = [];

  async send(message: unknown): Promise<void> {
    this.sentMessages.push(message);

    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      (message as { type?: unknown }).type !== "worker-request"
    ) {
      return;
    }

    const request =
      "request" in message && typeof message.request === "object" && message.request !== null
        ? (message.request as {
            id?: unknown;
            method?: unknown;
          })
        : null;
    if (!request || typeof request.id !== "string" || typeof request.method !== "string") {
      return;
    }

    queueMicrotask(() => {
      this.emit("message", {
        type: "worker-response",
        workerId: "git",
        response: {
          id: request.id,
          method: request.method,
          result: {
            type: "ok",
            value: {
              status: "success",
            },
          },
        },
      });
    });
  }

  async subscribe(): Promise<void> {}

  async unsubscribe(): Promise<void> {}

  async close(): Promise<void> {}
}

describeAppServerBridge(({ children }) => {
  it("forwards settings-targeted worktree deletes to the git worker with force enabled", async () => {
    const gitWorkerBridge = new TestGitWorkerBridge();
    const bridge = await createBridge(children, {
      gitWorkerBridge: gitWorkerBridge as never,
    });
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-worktree-delete",
      method: "POST",
      url: "vscode://codex/worktree-delete",
      body: JSON.stringify({
        hostId: "local",
        worktree: "/tmp/pocodex-worktree",
        reason: "settings-delete-targeted",
      }),
    });

    await waitForFetchResponse(emittedMessages, "fetch-worktree-delete");

    expect(getFetchResponse(emittedMessages, "fetch-worktree-delete")).toMatchObject({
      type: "fetch-response",
      requestId: "fetch-worktree-delete",
      responseType: "success",
      status: 200,
    });
    expect(gitWorkerBridge.sentMessages).toEqual([
      {
        type: "worker-request",
        workerId: "git",
        request: {
          id: expect.any(String),
          method: "delete-worktree",
          params: {
            worktree: "/tmp/pocodex-worktree",
            reason: "settings-delete-targeted",
            force: true,
            hostConfig: {
              id: "local",
              display_name: "Local",
              kind: "local",
            },
          },
        },
      },
    ]);

    await bridge.close();
  });
});

async function waitForFetchResponse(messages: unknown[], requestId: string): Promise<void> {
  const startedAt = Date.now();
  while (!getFetchResponse(messages, requestId)) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error(`Timed out waiting for fetch response ${requestId}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
