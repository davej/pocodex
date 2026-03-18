import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";

import { deriveCodexHomePath, listCodexHomePathCandidates } from "./codex-home.js";

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
  for (const candidatePath of listDesktopGlobalStatePathCandidates(globalStatePath)) {
    try {
      const raw = await readFile(candidatePath, "utf8");
      const projects = await parseCodexDesktopProjects(raw);
      return {
        found: true,
        path: candidatePath,
        projects,
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
    path: globalStatePath,
    projects: [],
  };
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
  const projectsByRoot = new Map<
    string,
    {
      active: boolean;
      label: unknown;
    }
  >();

  for (const rawRoot of roots) {
    const root = normalizeDesktopProjectRoot(rawRoot);
    const existingProject = projectsByRoot.get(root);
    projectsByRoot.set(root, {
      active:
        (existingProject?.active ?? false) || activeRoots.has(rawRoot) || activeRoots.has(root),
      label: existingProject?.label ?? labels[rawRoot] ?? labels[root],
    });
  }

  return Promise.all(
    Array.from(projectsByRoot.entries()).map(async ([root, project]) => ({
      root,
      label: resolveDesktopProjectLabel(root, project.label),
      active: project.active,
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

function listDesktopGlobalStatePathCandidates(globalStatePath: string): string[] {
  const candidates = [globalStatePath];
  if (globalStatePath !== deriveCodexDesktopGlobalStatePath()) {
    return candidates;
  }

  for (const codexHome of listCodexHomePathCandidates()) {
    const candidatePath = join(codexHome, ".codex-global-state.json");
    if (!candidates.includes(candidatePath)) {
      candidates.push(candidatePath);
    }
  }

  return candidates;
}

function normalizeDesktopProjectRoot(root: string): string {
  const normalizedWslUncPath = convertWslUncPathToLinux(root);
  if (normalizedWslUncPath) {
    return normalizedWslUncPath;
  }

  return convertWindowsPathToWsl(root);
}

function convertWindowsPathToWsl(path: string): string {
  if (!isRunningInWsl()) {
    return path;
  }

  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path;
  }

  const driveLetter = match[1].toLowerCase();
  const relativePath = match[2].replaceAll("\\", "/");
  return `/mnt/${driveLetter}/${relativePath}`;
}

function convertWslUncPathToLinux(path: string): string | null {
  if (!isRunningInWsl()) {
    return null;
  }

  const lowerCasePath = path.toLowerCase();
  let prefixLength = 0;
  if (lowerCasePath.startsWith("\\\\wsl$\\")) {
    prefixLength = "\\\\wsl$\\".length;
  } else if (lowerCasePath.startsWith("\\\\wsl.localhost\\")) {
    prefixLength = "\\\\wsl.localhost\\".length;
  } else {
    return null;
  }

  const segments = path
    .slice(prefixLength)
    .split("\\")
    .filter((segment) => segment.length > 0);
  const distroName = segments.shift();
  const currentDistroName = process.env.WSL_DISTRO_NAME?.trim().toLowerCase();
  if (!distroName) {
    return null;
  }
  if (currentDistroName && distroName.toLowerCase() !== currentDistroName) {
    return null;
  }

  return `/${segments.join("/")}`;
}

function isRunningInWsl(): boolean {
  return (
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}
