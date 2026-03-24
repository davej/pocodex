import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, ".codex-global-state.json");
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
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const sqliteFallback = await loadCodexCliProjectsFromSqlite(globalStatePath);
  if (sqliteFallback) {
    return sqliteFallback;
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

async function loadCodexCliProjectsFromSqlite(
  globalStatePath: string,
): Promise<LoadedCodexDesktopProjects | null> {
  const candidatePaths = await listCodexStateDatabasePaths(dirname(globalStatePath));
  for (const path of candidatePaths) {
    const projects = await loadProjectsFromStateDatabase(path);
    return {
      found: true,
      path,
      projects,
    };
  }

  return null;
}

async function listCodexStateDatabasePaths(codexHome: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(codexHome);
  } catch {
    return [];
  }

  const statePaths = await Promise.all(
    entries
      .filter((entry) => /^state_\d+\.sqlite$/u.test(entry))
      .map(async (entry) => {
        const path = join(codexHome, entry);
        try {
          const details = await stat(path);
          return details.isFile() ? { path, mtimeMs: details.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
  );

  return statePaths
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.path);
}

async function loadProjectsFromStateDatabase(path: string): Promise<CodexDesktopProject[]> {
  const database = new DatabaseSync(path, {
    readOnly: true,
  });

  try {
    const rows = database
      .prepare(
        `
          SELECT
            cwd,
            MAX(updated_at) AS updated_at,
            MAX(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active
          FROM threads
          WHERE TRIM(cwd) != ''
          GROUP BY cwd
          ORDER BY updated_at DESC
        `,
      )
      .all() as Array<{
      cwd: unknown;
      updated_at: unknown;
      active: unknown;
    }>;

    const projectsByRoot = new Map<
      string,
      {
        root: string;
        label: string;
        active: boolean;
        available: boolean;
        updatedAt: number;
      }
    >();

    for (const row of rows) {
      if (typeof row.cwd !== "string") {
        continue;
      }

      const root = await resolveWorkspaceRoot(row.cwd);
      if (!root) {
        continue;
      }

      const updatedAt =
        typeof row.updated_at === "number"
          ? row.updated_at
          : Number.parseInt(String(row.updated_at ?? "0"), 10) || 0;
      const active = row.active === 1 || row.active === "1";
      const available = await isDirectory(root);
      const existing = projectsByRoot.get(root);

      if (!existing || updatedAt > existing.updatedAt) {
        projectsByRoot.set(root, {
          root,
          label: basename(root) || "Project",
          active: existing ? existing.active || active : active,
          available,
          updatedAt,
        });
        continue;
      }

      existing.active = existing.active || active;
      existing.available = existing.available || available;
    }

    return [...projectsByRoot.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ root, label, active, available }) => ({
        root,
        label,
        active,
        available,
      }));
  } finally {
    database.close();
  }
}

async function resolveWorkspaceRoot(path: string): Promise<string | null> {
  const cwd = path.trim();
  if (cwd.length === 0) {
    return null;
  }

  try {
    const root = await runGitCommand(resolve(cwd), ["rev-parse", "--show-toplevel"]);
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
