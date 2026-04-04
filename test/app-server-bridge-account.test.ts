import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  describeAppServerBridge,
  createBridge,
  mockLocalRequestErrors,
  mockLocalRequestResults,
  mockLocalRequests,
  tempDirs,
  TEST_PUBLIC_ORIGIN_URL,
  writeWorkspaceRootRegistry,
  writeCodexAuthFile,
  createJsonResponse,
  normalizeFetchRequestHeaders,
  normalizeFetchRequestBody,
  getFetchResponse,
  getFetchJsonBody,
  waitForCondition,
  createGitOriginFixture,
} from "./support/app-server-bridge-test-kit.js";

describeAppServerBridge(({ children }) => {
  it("resolves git origins for repo-backed directories", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-origins-"));
    tempDirs.push(tempDirectory);
    const { repoRoot, nestedDirectory, outsideDirectory } =
      await createGitOriginFixture(tempDirectory);

    const bridge = await createBridge(children);
    try {
      const emittedMessages: unknown[] = [];
      bridge.on("bridge_message", (message) => {
        emittedMessages.push(message);
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-git-origins",
        method: "POST",
        url: "vscode://codex/git-origins",
        body: JSON.stringify({
          params: {
            dirs: [repoRoot, nestedDirectory, outsideDirectory],
          },
        }),
      });

      await waitForCondition(() =>
        emittedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "requestId" in message &&
            message.type === "fetch-response" &&
            message.requestId === "fetch-git-origins",
        ),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-git-origins")).toEqual({
        origins: [
          {
            dir: repoRoot,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
          {
            dir: nestedDirectory,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
        ],
        homeDir: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("resolves git origins from workspace roots when dirs are omitted", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-origins-"));
    tempDirs.push(tempDirectory);
    const { repoRoot } = await createGitOriginFixture(tempDirectory);
    const workspaceRootRegistryPath = await writeWorkspaceRootRegistry(tempDirectory, {
      roots: [repoRoot],
      activeRoot: repoRoot,
    });

    const bridge = await createBridge(children, {
      workspaceRootRegistryPath,
    });
    try {
      const emittedMessages: unknown[] = [];
      bridge.on("bridge_message", (message) => {
        emittedMessages.push(message);
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-git-origins-defaults",
        method: "POST",
        url: "vscode://codex/git-origins",
      });

      await waitForCondition(() =>
        emittedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "requestId" in message &&
            message.type === "fetch-response" &&
            message.requestId === "fetch-git-origins-defaults",
        ),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-git-origins-defaults")).toEqual({
        origins: [
          {
            dir: repoRoot,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
        ],
        homeDir: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("includes sibling worktrees when resolving git origins", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "pocodex-git-origins-"));
    tempDirs.push(tempDirectory);
    const { repoRoot, worktreeRoot } = await createGitOriginFixture(tempDirectory, {
      addWorktree: true,
    });
    if (!worktreeRoot) {
      throw new Error("Expected linked worktree fixture to be created");
    }

    const bridge = await createBridge(children);
    try {
      const emittedMessages: unknown[] = [];
      bridge.on("bridge_message", (message) => {
        emittedMessages.push(message);
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-git-origins-worktrees",
        method: "POST",
        url: "vscode://codex/git-origins",
        body: JSON.stringify({
          params: {
            dirs: [repoRoot],
          },
        }),
      });

      await waitForCondition(() =>
        emittedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            "requestId" in message &&
            message.type === "fetch-response" &&
            message.requestId === "fetch-git-origins-worktrees",
        ),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-git-origins-worktrees")).toEqual({
        origins: [
          {
            dir: repoRoot,
            root: repoRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
          {
            dir: worktreeRoot,
            root: worktreeRoot,
            originUrl: TEST_PUBLIC_ORIGIN_URL,
          },
        ],
        homeDir: expect.any(String),
      });
    } finally {
      await bridge.close();
    }
  });

  it("proxies wham endpoints through backend-api with managed auth", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    await writeCodexAuthFile(codexHome, {
      accessToken: "test-access-token",
      accountId: "acct_personal",
    });

    const proxiedRequests: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: normalizeFetchRequestHeaders(init?.headers),
        body: normalizeFetchRequestBody(init?.body),
      };
      proxiedRequests.push(request);

      if (request.url === "https://chatgpt.com/backend-api/wham/environments") {
        return createJsonResponse([{ id: "env_1", name: "Default" }]);
      }
      if (
        request.url ===
        "https://chatgpt.com/backend-api/wham/tasks/list?limit=20&task_filter=current"
      ) {
        return createJsonResponse({
          items: [{ id: "task_1", status: "running" }],
          cursor: "cursor_1",
        });
      }
      if (request.url === "https://chatgpt.com/backend-api/wham/accounts/check") {
        return createJsonResponse({
          accounts: [{ id: "acct_personal", status: "active" }],
          account_ordering: ["acct_personal"],
          default_account_id: "acct_personal",
        });
      }
      if (request.url === "https://chatgpt.com/backend-api/wham/usage") {
        return createJsonResponse({
          plan_type: "plus",
          credits: null,
        });
      }
      if (request.url === "https://chatgpt.com/backend-api/wham/tasks") {
        return createJsonResponse(
          {
            id: "task_new",
            status: "queued",
          },
          201,
        );
      }

      throw new Error(`Unexpected proxied fetch: ${request.url}`);
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-environments",
        method: "GET",
        url: "/wham/environments",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-tasks",
        method: "GET",
        url: "/wham/tasks/list?limit=20&task_filter=current",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-accounts",
        method: "GET",
        url: "/wham/accounts/check",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-usage",
        method: "GET",
        url: "/wham/usage",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-create-task",
        method: "POST",
        url: "/wham/tasks",
        headers: {
          "x-test-header": "keep-me",
        },
        body: JSON.stringify({
          prompt: "ship it",
        }),
      });

      await waitForCondition(() =>
        Boolean(getFetchResponse(emittedMessages, "fetch-wham-create-task")),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([
        {
          id: "env_1",
          name: "Default",
        },
      ]);
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-tasks")).toEqual({
        items: [{ id: "task_1", status: "running" }],
        cursor: "cursor_1",
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-accounts")).toEqual({
        accounts: [{ id: "acct_personal", status: "active" }],
        account_ordering: ["acct_personal"],
        default_account_id: "acct_personal",
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage")).toEqual({
        plan_type: "plus",
        credits: null,
      });
      expect(getFetchResponse(emittedMessages, "fetch-wham-create-task")).toMatchObject({
        status: 201,
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-create-task")).toEqual({
        id: "task_new",
        status: "queued",
      });

      expect(proxiedRequests.map((request) => request.url)).toEqual([
        "https://chatgpt.com/backend-api/wham/environments",
        "https://chatgpt.com/backend-api/wham/tasks/list?limit=20&task_filter=current",
        "https://chatgpt.com/backend-api/wham/accounts/check",
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/backend-api/wham/tasks",
      ]);

      for (const request of proxiedRequests) {
        expect(request.headers.authorization).toBe("Bearer test-access-token");
        expect(request.headers["chatgpt-account-id"]).toBe("acct_personal");
        expect(request.headers.originator).toBe("codex_cli_rs");
      }

      expect(proxiedRequests.at(-1)).toMatchObject({
        method: "POST",
        body: JSON.stringify({
          prompt: "ship it",
        }),
      });
      expect(proxiedRequests.at(-1)?.headers["content-type"]).toBe("application/json");
      expect(proxiedRequests.at(-1)?.headers["x-test-header"]).toBe("keep-me");
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it.each([
    {
      name: "managed auth file is missing",
      auth: null,
    },
    {
      name: "managed auth is missing an access token",
      auth: {
        accountId: "acct_personal",
      },
    },
    {
      name: "managed auth is missing an account id",
      auth: {
        accessToken: "test-access-token",
      },
    },
  ])("falls back to local placeholder wham responses when $name", async ({ auth }) => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;

    if (auth) {
      await writeCodexAuthFile(codexHome, auth);
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected remote fetch");
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-environments",
        method: "GET",
        url: "/wham/environments",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-tasks",
        method: "GET",
        url: "/wham/tasks/list?limit=20&task_filter=current",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-accounts",
        method: "GET",
        url: "/wham/accounts/check",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-usage",
        method: "GET",
        url: "/wham/usage",
      });

      await waitForCondition(() => Boolean(getFetchResponse(emittedMessages, "fetch-wham-usage")));

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([]);
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-tasks")).toEqual({
        items: [],
        tasks: [],
        nextCursor: null,
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-accounts")).toEqual({
        accounts: [],
        account_ordering: [],
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage")).toEqual({
        credits: null,
        plan_type: null,
        rate_limit_name: null,
        rate_limit: null,
        additional_rate_limits: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("refreshes managed auth and retries wham requests once after a 401", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    await writeCodexAuthFile(codexHome, {
      accessToken: "stale-access-token",
      accountId: "acct_stale",
    });

    const proxiedRequests: Array<{ headers: Record<string, string> }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const headers = normalizeFetchRequestHeaders(init?.headers);
      proxiedRequests.push({ headers });

      if (headers.authorization === "Bearer stale-access-token") {
        await writeCodexAuthFile(codexHome, {
          accessToken: "fresh-access-token",
          accountId: "acct_fresh",
        });
        return createJsonResponse(
          {
            error: "expired",
          },
          401,
        );
      }

      if (headers.authorization === "Bearer fresh-access-token") {
        return createJsonResponse([{ id: "env_1" }]);
      }

      throw new Error("Unexpected auth header");
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-environments",
        method: "GET",
        url: "/wham/environments",
      });

      await waitForCondition(() =>
        Boolean(getFetchResponse(emittedMessages, "fetch-wham-environments")),
      );

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-environments")).toEqual([
        {
          id: "env_1",
        },
      ]);
      expect(proxiedRequests).toHaveLength(2);
      expect(proxiedRequests[0]?.headers.authorization).toBe("Bearer stale-access-token");
      expect(proxiedRequests[1]?.headers.authorization).toBe("Bearer fresh-access-token");
      expect(mockLocalRequests).toContainEqual({
        method: "account/read",
        params: {
          refreshToken: true,
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("returns a safe local usage fallback when account rate limits cannot be read", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-codex-home-"));
    tempDirs.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected remote fetch");
    });
    mockLocalRequestErrors.set("account/rateLimits/read", "rate limits unavailable");

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-wham-usage-fallback",
        method: "GET",
        url: "/wham/usage",
      });

      await waitForCondition(() => emittedMessages.length >= 1);

      expect(getFetchJsonBody(emittedMessages, "fetch-wham-usage-fallback")).toEqual({
        credits: null,
        plan_type: null,
        rate_limit_name: null,
        rate_limit: null,
        additional_rate_limits: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });

  it("reads account info from the local app server and filters unsupported plans", async () => {
    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    mockLocalRequestResults.set("account/read", {
      account: {
        planType: "plus",
      },
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-account-plus",
      method: "POST",
      url: "vscode://codex/account-info",
    });

    mockLocalRequestResults.set("account/read", {
      account: {
        planType: "enterprise",
      },
    });

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-account-unsupported",
      method: "POST",
      url: "vscode://codex/account-info",
    });

    mockLocalRequestErrors.set("account/read", "account unavailable");

    await bridge.forwardBridgeMessage({
      type: "fetch",
      requestId: "fetch-account-error",
      method: "POST",
      url: "vscode://codex/account-info",
    });

    await waitForCondition(() => emittedMessages.length >= 3);

    expect(getFetchJsonBody(emittedMessages, "fetch-account-plus")).toEqual({
      plan: "plus",
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-account-unsupported")).toEqual({
      plan: null,
    });
    expect(getFetchJsonBody(emittedMessages, "fetch-account-error")).toEqual({
      plan: null,
    });

    await bridge.close();
  });

  it("serves read-only billing endpoints locally and blocks unsupported billing actions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected remote fetch");
    });

    const bridge = await createBridge(children);
    const emittedMessages: unknown[] = [];
    bridge.on("bridge_message", (message) => {
      emittedMessages.push(message);
    });

    try {
      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-settings",
        method: "GET",
        url: "/subscriptions/auto_top_up/settings",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-accounts-check-versioned",
        method: "GET",
        url: "/accounts/check/v4-2023-04-27",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-pricing-config",
        method: "GET",
        url: "/checkout_pricing_config/configs/USD",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-enable",
        method: "POST",
        url: "/subscriptions/auto_top_up/enable",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-update",
        method: "POST",
        url: "/subscriptions/auto_top_up/update",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-auto-top-up-disable",
        method: "POST",
        url: "/subscriptions/auto_top_up/disable",
      });

      await bridge.forwardBridgeMessage({
        type: "fetch",
        requestId: "fetch-customer-portal",
        method: "GET",
        url: "/payments/customer_portal",
      });

      await waitForCondition(() => emittedMessages.length >= 7);

      expect(getFetchJsonBody(emittedMessages, "fetch-auto-top-up-settings")).toEqual({
        is_enabled: false,
        recharge_threshold: null,
        recharge_target: null,
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-accounts-check-versioned")).toEqual({
        accounts: {},
      });
      expect(getFetchJsonBody(emittedMessages, "fetch-pricing-config")).toEqual({
        currency_config: null,
      });

      for (const requestId of [
        "fetch-auto-top-up-enable",
        "fetch-auto-top-up-update",
        "fetch-auto-top-up-disable",
        "fetch-customer-portal",
      ]) {
        expect(getFetchResponse(emittedMessages, requestId)).toMatchObject({
          type: "fetch-response",
          requestId,
          responseType: "success",
          status: 501,
        });
        expect(getFetchJsonBody(emittedMessages, requestId)).toEqual({
          error: "unsupported in Pocodex",
        });
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await bridge.close();
    }
  });
});
