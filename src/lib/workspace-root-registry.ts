import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { deriveCodexHomePath } from "./codex-home.js";

export interface WorkspaceRootRegistryState {
  roots: string[];
  labels: Record<string, string>;
  activeRoot: string | null;
  desktopImportPromptSeen: boolean;
}

export interface LoadedWorkspaceRootRegistry {
  found: boolean;
  state: WorkspaceRootRegistryState | null;
}

export function deriveWorkspaceRootRegistryPath(): string {
  return join(deriveCodexHomePath(), "pocodex", "workspace-roots.json");
}

export async function loadWorkspaceRootRegistry(
  registryPath: string,
): Promise<LoadedWorkspaceRootRegistry> {
  try {
    const raw = await readFile(registryPath, "utf8");
    return {
      found: true,
      state: parseWorkspaceRootRegistry(raw),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        found: false,
        state: null,
      };
    }
    throw error;
  }
}

export async function saveWorkspaceRootRegistry(
  registryPath: string,
  state: WorkspaceRootRegistryState,
): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        roots: state.roots,
        labels: state.labels,
        activeRoot: state.activeRoot,
        desktopImportPromptSeen: state.desktopImportPromptSeen,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parseWorkspaceRootRegistry(raw: string): WorkspaceRootRegistryState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isJsonRecord(parsed)) {
    return null;
  }

  const roots = Array.isArray(parsed.roots) ? uniqueStrings(parsed.roots) : [];
  const labels: Record<string, string> = {};
  if (isJsonRecord(parsed.labels)) {
    for (const [root, value] of Object.entries(parsed.labels)) {
      if (roots.includes(root) && typeof value === "string" && value.trim().length > 0) {
        labels[root] = value;
      }
    }
  }
  const activeRoot =
    typeof parsed.activeRoot === "string" && roots.includes(parsed.activeRoot)
      ? parsed.activeRoot
      : null;
  const desktopImportPromptSeen = parsed.desktopImportPromptSeen === true;

  return {
    roots,
    labels,
    activeRoot,
    desktopImportPromptSeen,
  };
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
