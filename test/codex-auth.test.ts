import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCodexAuthState } from "../src/lib/codex-auth.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("readCodexAuthState", () => {
  it("reads account, email, and user identifiers from auth.json tokens", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-auth-"));
    tempDirs.push(codexHome);
    await mkdir(codexHome, { recursive: true });

    const accessPayload = {
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_user_id: "user-123",
      },
      "https://api.openai.com/profile": {
        email: "dev@example.com",
      },
    };
    const idPayload = {
      "https://api.openai.com/auth": {
        chatgpt_user_id: "user-456",
      },
      email: "other@example.com",
    };

    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: createJwt(accessPayload),
          account_id: "account-123",
          id_token: createJwt(idPayload),
        },
      }),
      "utf8",
    );

    await expect(readCodexAuthState(codexHome)).resolves.toEqual({
      accountId: "account-123",
      email: "dev@example.com",
      userId: "user-123",
    });
  });

  it("returns null when auth.json does not contain usable identifiers", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-auth-"));
    tempDirs.push(codexHome);
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");

    await expect(readCodexAuthState(codexHome)).resolves.toBeNull();
  });
});

function createJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}
