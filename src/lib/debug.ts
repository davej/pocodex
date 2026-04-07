const DEBUG_ALL_TOKENS = new Set(["1", "true", "yes", "on", "all", "*"]);
const MAX_DEBUG_STRING_LENGTH = 400;
const MAX_DEBUG_ARRAY_LENGTH = 20;
const MAX_DEBUG_OBJECT_KEYS = 20;
const MAX_DEBUG_DEPTH = 5;

export function isDebugEnabled(scope?: string): boolean {
  const raw = process.env.POCODEX_DEBUG?.trim();
  if (!raw) {
    return false;
  }

  const normalized = raw.toLowerCase();
  if (DEBUG_ALL_TOKENS.has(normalized)) {
    return true;
  }

  if (!scope) {
    return true;
  }

  const scopes = normalized
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (scopes.length === 0) {
    return false;
  }

  const normalizedScope = scope.toLowerCase();
  return scopes.includes(normalizedScope);
}

export function debugLog(scope: string, message: string, details?: unknown): void {
  if (!isDebugEnabled(scope)) {
    return;
  }

  const prefix = `[pocodex:${scope}] ${message}`;
  if (details === undefined) {
    console.log(prefix);
    return;
  }

  try {
    console.log(prefix, JSON.stringify(sanitizeDebugValue(details, 0)));
  } catch {
    console.log(prefix, String(details));
  }
}

function sanitizeDebugValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return truncateDebugString(value);
  }

  if (depth >= MAX_DEBUG_DEPTH) {
    return `[truncated depth=${depth}]`;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_DEBUG_ARRAY_LENGTH)
      .map((item) => sanitizeDebugValue(item, depth + 1));
    if (value.length > MAX_DEBUG_ARRAY_LENGTH) {
      items.push(`[+${value.length - MAX_DEBUG_ARRAY_LENGTH} more items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    return sanitizeDebugObject(value as Record<string, unknown>, depth + 1);
  }

  return String(value);
}

function sanitizeDebugObject(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const entries = Object.entries(value);
  const sanitized = Object.fromEntries(
    entries
      .slice(0, MAX_DEBUG_OBJECT_KEYS)
      .map(([key, entryValue]) => [
        key,
        key === "bodyJsonString" && typeof entryValue === "string"
          ? summarizeBodyJsonString(entryValue)
          : sanitizeDebugValue(entryValue, depth),
      ]),
  );

  if (entries.length > MAX_DEBUG_OBJECT_KEYS) {
    sanitized.__truncatedKeys = entries.length - MAX_DEBUG_OBJECT_KEYS;
  }

  return sanitized;
}

function truncateDebugString(value: string): string {
  if (value.length <= MAX_DEBUG_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_DEBUG_STRING_LENGTH)}...[+${value.length - MAX_DEBUG_STRING_LENGTH} chars]`;
}

function summarizeBodyJsonString(value: string): string {
  const truncated = truncateDebugString(value);
  return `[bodyJsonString length=${value.length}] ${truncated}`;
}
