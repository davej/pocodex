import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { deriveCodexHomePath, listCodexHomePathCandidates } from "./codex-home.js";

export interface LoadedPersistedAtomRegistry {
  found: boolean;
  path: string;
  state: Record<string, unknown>;
}

export function derivePersistedAtomRegistryPath(): string {
  return join(deriveCodexHomePath(), "pocodex", "persisted-atoms.json");
}

export async function loadPersistedAtomRegistry(
  registryPath: string,
): Promise<LoadedPersistedAtomRegistry> {
  for (const candidatePath of listPersistedAtomRegistryPathCandidates(registryPath)) {
    try {
      const raw = await readFile(candidatePath, "utf8");
      return {
        found: true,
        path: candidatePath,
        state: parsePersistedAtomRegistry(raw),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }

  return {
    found: false,
    path: registryPath,
    state: {},
  };
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

function listPersistedAtomRegistryPathCandidates(registryPath: string): string[] {
  const candidates = [registryPath];
  if (registryPath !== derivePersistedAtomRegistryPath()) {
    return candidates;
  }

  for (const codexHome of listCodexHomePathCandidates()) {
    const candidatePath = join(codexHome, "pocodex", "persisted-atoms.json");
    if (!candidates.includes(candidatePath)) {
      candidates.push(candidatePath);
    }
  }

  return candidates;
}
