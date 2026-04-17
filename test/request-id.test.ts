import { describe, expect, it } from "vitest";

import { routeHostMessage, rewriteRequestIdsForHost } from "../src/lib/request-id.js";

describe("request-id routing", () => {
  it("prefixes browser fetch request IDs for the host renderer", () => {
    const rewritten = rewriteRequestIdsForHost("session-a", {
      type: "fetch",
      requestId: "request-1",
      url: "vscode://codex/test",
    }) as { requestId: string };

    expect(rewritten.requestId).toBe("pocodex:session-a:request-1");
  });

  it("prefixes nested MCP request IDs for the host renderer", () => {
    const rewritten = rewriteRequestIdsForHost("session-a", {
      type: "mcp-request",
      request: {
        id: "mcp-1",
      },
    }) as { request: { id: string } };

    expect(rewritten.request.id).toBe("pocodex:session-a:mcp-1");
  });

  it("prefixes thread prewarm request IDs for the host renderer", () => {
    const rewritten = rewriteRequestIdsForHost("session-a", {
      type: "thread-prewarm-start",
      request: {
        id: "prewarm-1",
      },
    }) as { request: { id: string } };

    expect(rewritten.request.id).toBe("pocodex:session-a:prewarm-1");
  });

  it("strips prefixed host response IDs and routes them to the right session", () => {
    const routed = routeHostMessage({
      type: "fetch-response",
      requestId: "pocodex:session-a:request-1",
      status: 200,
    });

    expect(routed).toEqual({
      deliver: true,
      sessionId: "session-a",
      message: {
        type: "fetch-response",
        requestId: "request-1",
        status: 200,
      },
    });
  });

  it("drops host response IDs that were not created by Pocodex", () => {
    const routed = routeHostMessage({
      type: "fetch-response",
      requestId: "desktop-only-request",
      status: 200,
    });

    expect(routed).toEqual({ deliver: false });
  });

  it("routes MCP responses by response.id", () => {
    const routed = routeHostMessage({
      type: "mcp-response",
      hostId: "local",
      response: {
        id: "pocodex:session-a:mcp-1",
        result: { ok: true },
      },
    });

    expect(routed).toEqual({
      deliver: true,
      sessionId: "session-a",
      message: {
        type: "mcp-response",
        hostId: "local",
        response: {
          id: "mcp-1",
          result: { ok: true },
        },
      },
    });
  });
});
