import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { deriveCodexHomePath } from "./codex-home.js";

export interface CodexDesktopProject {
  root: string;
  label: string;
  active: boolean;
  available: boolean;
}

export interface LoadedCodexDesktopProjects {
  found: boolean;
  path: string;
  projects: CodexDesktopProject[];
}

export function deriveCodexDesktopGlobalStatePath(): string {
  return join(deriveCodexHomePath(), ".codex-global-state.json");
}

export async function loadCodexDesktopProjects(
  globalStatePath: string,
): Promise<LoadedCodexDesktopProjects> {
  try {
    const raw = await readFile(globalStatePath, "utf8");
    const projects = await parseCodexDesktopProjects(raw);
    return {
      found: true,
      path: globalStatePath,
      projects,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        found: false,
        path: globalStatePath,
        projects: [],
      };
    }
    throw error;
  }
}

async function parseCodexDesktopProjects(raw: string): Promise<CodexDesktopProject[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isJsonRecord(parsed)) {
    return [];
  }

  const roots = uniqueStrings(parsed["electron-saved-workspace-roots"]);
  const activeRoots = new Set(uniqueStrings(parsed["active-workspace-roots"]));
  const labels = isJsonRecord(parsed["electron-workspace-root-labels"])
    ? parsed["electron-workspace-root-labels"]
    : {};

  return Promise.all(
    roots.map(async (root) => ({
      root,
      label: resolveDesktopProjectLabel(root, labels[root]),
      active: activeRoots.has(root),
      available: await isDirectory(root),
    })),
  );
}

function resolveDesktopProjectLabel(root: string, label: unknown): string {
  return typeof label === "string" && label.trim().length > 0
    ? label.trim()
    : basename(root) || "Project";
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
