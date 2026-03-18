import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { deriveCodexHomePath } from "./codex-home.js";

export interface LoadedPersistedAtomRegistry {
  found: boolean;
  state: Record<string, unknown>;
}

export function derivePersistedAtomRegistryPath(): string {
  return join(deriveCodexHomePath(), "pocodex", "persisted-atoms.json");
}

export async function loadPersistedAtomRegistry(
  registryPath: string,
): Promise<LoadedPersistedAtomRegistry> {
  try {
    const raw = await readFile(registryPath, "utf8");
    return {
      found: true,
      state: parsePersistedAtomRegistry(raw),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        found: false,
        state: {},
      };
    }
    throw error;
  }
}

export async function savePersistedAtomRegistry(
  registryPath: string,
  state: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        atoms: state,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parsePersistedAtomRegistry(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.atoms)) {
    return {};
  }

  return { ...parsed.atoms };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
