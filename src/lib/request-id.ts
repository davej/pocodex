import type { HostMessageRouteResult, JsonRecord } from "./protocol.js";

const PREFIX = "pocodex";

export function rewriteRequestIdsForHost(sessionId: string, message: unknown): unknown {
  if (!isJsonRecord(message)) {
    return message;
  }

  if (typeof message.requestId === "string") {
    return {
      ...message,
      requestId: prefixRequestId(sessionId, message.requestId),
    };
  }

  if (
    (message.type === "mcp-request" || message.type === "thread-prewarm-start") &&
    isJsonRecord(message.request) &&
    typeof message.request.id === "string"
  ) {
    return {
      ...message,
      request: {
        ...message.request,
        id: prefixRequestId(sessionId, message.request.id),
      },
    };
  }

  if (
    (message.type === "mcp-request" || message.type === "thread-prewarm-start") &&
    isJsonRecord(message.message) &&
    typeof message.message.id === "string"
  ) {
    return {
      ...message,
      message: {
        ...message.message,
        id: prefixRequestId(sessionId, message.message.id),
      },
    };
  }

  return message;
}

export function routeHostMessage(message: unknown): HostMessageRouteResult {
  if (!isJsonRecord(message)) {
    return {
      deliver: true,
      message,
    };
  }

  if (typeof message.requestId === "string") {
    const parsed = stripPrefixedRequestId(message.requestId);
    if (!parsed) {
      return { deliver: false };
    }
    return {
      deliver: true,
      sessionId: parsed.sessionId,
      message: {
        ...message,
        requestId: parsed.requestId,
      },
    };
  }

  if (
    message.type === "mcp-response" &&
    isJsonRecord(message.response) &&
    typeof message.response.id === "string"
  ) {
    const parsed = stripPrefixedRequestId(message.response.id);
    if (!parsed) {
      return { deliver: false };
    }
    return {
      deliver: true,
      sessionId: parsed.sessionId,
      message: {
        ...message,
        response: {
          ...message.response,
          id: parsed.requestId,
        },
      },
    };
  }

  if (
    message.type === "mcp-response" &&
    isJsonRecord(message.message) &&
    typeof message.message.id === "string"
  ) {
    const parsed = stripPrefixedRequestId(message.message.id);
    if (!parsed) {
      return { deliver: false };
    }
    return {
      deliver: true,
      sessionId: parsed.sessionId,
      message: {
        ...message,
        message: {
          ...message.message,
          id: parsed.requestId,
        },
      },
    };
  }

  return {
    deliver: true,
    message,
  };
}

function prefixRequestId(sessionId: string, requestId: string): string {
  return `${PREFIX}:${sessionId}:${requestId}`;
}

function stripPrefixedRequestId(value: string): { sessionId: string; requestId: string } | null {
  if (!value.startsWith(`${PREFIX}:`)) {
    return null;
  }

  const firstSeparator = value.indexOf(":", PREFIX.length + 1);
  if (firstSeparator === -1 || firstSeparator === value.length - 1) {
    return null;
  }

  return {
    sessionId: value.slice(PREFIX.length + 1, firstSeparator),
    requestId: value.slice(firstSeparator + 1),
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}
