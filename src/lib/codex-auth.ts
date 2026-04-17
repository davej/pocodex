import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { deriveCodexHomePath } from "./codex-home.js";

export interface CodexAuthState {
  accountId: string | null;
  email: string | null;
  userId: string | null;
}

export async function readCodexAuthState(
  codexHomePath = deriveCodexHomePath(),
): Promise<CodexAuthState | null> {
  try {
    const authJson = JSON.parse(
      await readFile(join(codexHomePath, "auth.json"), "utf8"),
    ) as unknown;
    if (!isJsonRecord(authJson)) {
      return null;
    }

    const tokens = isJsonRecord(authJson.tokens) ? authJson.tokens : null;
    const accessPayload = decodeJwtPayload(
      typeof tokens?.access_token === "string" ? tokens.access_token : null,
    );
    const idPayload = decodeJwtPayload(
      typeof tokens?.id_token === "string" ? tokens.id_token : null,
    );
    const accessAuth = readOpenAiAuthClaims(accessPayload);
    const idAuth = readOpenAiAuthClaims(idPayload);
    const accessProfile = readOpenAiProfileClaims(accessPayload);

    const accountId = firstNonEmptyString(
      typeof tokens?.account_id === "string" ? tokens.account_id : null,
      readString(accessAuth?.chatgpt_account_id),
      readString(idAuth?.chatgpt_account_id),
    );
    const userId = firstNonEmptyString(
      readString(accessAuth?.user_id),
      readString(accessAuth?.chatgpt_user_id),
      readString(idAuth?.user_id),
      readString(idAuth?.chatgpt_user_id),
    );
    const email = firstNonEmptyString(
      readString(accessProfile?.email),
      readString(idPayload?.email),
    );

    if (!accountId && !userId && !email) {
      return null;
    }

    return {
      accountId,
      email,
      userId,
    };
  } catch {
    return null;
  }
}

function readOpenAiAuthClaims(payload: JsonRecord | null): JsonRecord | null {
  return isJsonRecord(payload?.["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : null;
}

function readOpenAiProfileClaims(payload: JsonRecord | null): JsonRecord | null {
  return isJsonRecord(payload?.["https://api.openai.com/profile"])
    ? payload["https://api.openai.com/profile"]
    : null;
}

function decodeJwtPayload(token: string | null): JsonRecord | null {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isJsonRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstNonEmptyString(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (value) {
      return value;
    }
  }

  return null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface JsonRecord {
  [key: string]: unknown;
}
