import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import * as asar from "@electron/asar";
import plist from "plist";

interface CodexDesktopPackageJson {
  version?: string;
  codexBuildFlavor?: string;
  codexBuildNumber?: string;
}

interface CodexInfoPlist {
  CFBundleShortVersionString?: string;
}

type CodexDesktopLayout = "macos-app" | "windows-app";

export interface CodexBundle {
  appPath: string;
  version: string;
  buildFlavor: string;
  buildNumber: string;
  webviewRoot: string;
  faviconHref: string | null;
  readIndexHtml: () => Promise<string>;
}

export interface CodexDesktopMetadata {
  appPath: string;
  appAsarPath: string;
  cliBinaryPath: string;
  layout: CodexDesktopLayout;
  version: string;
  buildFlavor: string;
  buildNumber: string;
}

export interface CodexDesktopWorkerScript {
  metadata: CodexDesktopMetadata;
  workerPath: string;
}

interface ResolvedCodexDesktopPaths {
  appPath: string;
  appAsarPath: string;
  cliBinaryPath: string;
  infoPlistPath?: string;
  layout: CodexDesktopLayout;
}

const execFileAsync = promisify(execFile);

export async function loadCodexBundle(appPath: string): Promise<CodexBundle> {
  const metadata = await loadCodexDesktopMetadata(appPath);
  const webviewRoot = await ensureWebviewCache(metadata);
  await ensurePocodexWebviewPatches(webviewRoot);
  const faviconHref = await resolveWebviewFaviconHref(webviewRoot);

  return {
    appPath: metadata.appPath,
    version: metadata.version,
    buildFlavor: metadata.buildFlavor,
    buildNumber: metadata.buildNumber,
    webviewRoot,
    faviconHref,
    readIndexHtml: async () => readFile(join(webviewRoot, "index.html"), "utf8"),
  };
}

export async function resolveDefaultCodexAppPath(): Promise<string> {
  const requestedAppPath = process.env.POCODEX_APP_PATH;
  if (requestedAppPath) {
    return (await resolveCodexDesktopPaths(requestedAppPath)).appPath;
  }

  const candidates = ["/Applications/Codex.app", ...(await discoverWindowsStoreCodexApps())];

  for (const candidate of candidates) {
    try {
      return (await resolveCodexDesktopPaths(candidate)).appPath;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    [
      "Unable to locate a Codex desktop install automatically.",
      "Pass --app <path> to a macOS bundle like /Applications/Codex.app",
      "or, when running inside WSL, to a Windows install like",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_...\\app.",
    ].join(" "),
  );
}

export async function loadCodexDesktopMetadata(appPath: string): Promise<CodexDesktopMetadata> {
  const paths = await resolveCodexDesktopPaths(appPath);
  const infoPlist = paths.infoPlistPath
    ? (plist.parse(await readFile(paths.infoPlistPath, "utf8")) as CodexInfoPlist)
    : {};
  const desktopPackage = JSON.parse(
    await extractAsarText(paths.appAsarPath, "package.json"),
  ) as CodexDesktopPackageJson;

  return {
    appPath: paths.appPath,
    appAsarPath: paths.appAsarPath,
    cliBinaryPath: paths.cliBinaryPath,
    layout: paths.layout,
    version: desktopPackage.version ?? infoPlist.CFBundleShortVersionString ?? "unknown",
    buildFlavor: desktopPackage.codexBuildFlavor ?? "prod",
    buildNumber: desktopPackage.codexBuildNumber ?? "0",
  };
}

export async function ensureCodexCliBinary(appPath: string): Promise<string> {
  const metadata = await loadCodexDesktopMetadata(appPath);

  if (await isExecutable(metadata.cliBinaryPath)) {
    return metadata.cliBinaryPath;
  }

  const cliDirectory = join(cacheRootForBuild(metadata), "__cli", metadata.layout);
  const markerPath = join(cliDirectory, ".complete");
  const cliFilename = basename(metadata.cliBinaryPath);
  const cachedCliPath = join(cliDirectory, cliFilename);

  try {
    await stat(markerPath);
    await access(cachedCliPath, constants.X_OK);
    return cachedCliPath;
  } catch {
    // Continue and rebuild the staged executable.
  }

  const parentDirectory = dirname(cliDirectory);
  await mkdir(parentDirectory, { recursive: true });
  await rm(cliDirectory, { recursive: true, force: true });

  const tempDirectory = await mkdtemp(join(parentDirectory, "cli-"));
  const tempCliPath = join(tempDirectory, cliFilename);

  try {
    await copyFile(metadata.cliBinaryPath, tempCliPath);
    await chmod(tempCliPath, 0o755);
    await writeFile(markerPathFor(tempDirectory), "ok");
    await promoteCacheDirectory(tempDirectory, cliDirectory, markerPath);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw new Error(`Failed to stage the bundled Codex CLI from ${metadata.cliBinaryPath}.`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  return cachedCliPath;
}

export async function ensureCodexDesktopWorkerScript(
  appPath: string,
): Promise<CodexDesktopWorkerScript> {
  const metadata = await loadCodexDesktopMetadata(appPath);
  const workerPath = await ensureDesktopWorkerCache(metadata);
  return {
    metadata,
    workerPath,
  };
}

async function ensureWebviewCache(metadata: CodexDesktopMetadata): Promise<string> {
  const buildCacheRoot = cacheRootForBuild(metadata);
  const webviewDirectory = join(buildCacheRoot, "__webview");
  const markerPath = join(webviewDirectory, ".complete");
  const legacyMarkerPath = join(buildCacheRoot, ".complete");
  const legacyIndexPath = join(buildCacheRoot, "index.html");

  try {
    await stat(markerPath);
    return webviewDirectory;
  } catch {
    // continue and build the cache
  }

  try {
    await stat(legacyMarkerPath);
    await stat(legacyIndexPath);
    return buildCacheRoot;
  } catch {
    // continue and build the cache
  }

  await mkdir(buildCacheRoot, { recursive: true });
  const tempDirectory = await mkdtemp(join(buildCacheRoot, "webview-"));

  try {
    const archiveEntries = asar.listPackage(metadata.appAsarPath, { isPack: false });
    for (const archiveEntry of archiveEntries) {
      if (!archiveEntry.startsWith("/webview/")) {
        continue;
      }

      const relativePath = archiveEntry.slice("/webview/".length);
      if (!relativePath) {
        continue;
      }

      const entry = asar.statFile(metadata.appAsarPath, archiveEntry.slice(1), false);
      if ("files" in entry || "link" in entry) {
        continue;
      }

      const destinationPath = join(tempDirectory, relativePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      const buffer = asar.extractFile(metadata.appAsarPath, archiveEntry.slice(1));
      await writeFile(destinationPath, buffer);
    }

    await writeFile(markerPathFor(tempDirectory), "ok");
    await promoteCacheDirectory(tempDirectory, webviewDirectory, markerPath);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  return webviewDirectory;
}

async function ensureDesktopWorkerCache(metadata: CodexDesktopMetadata): Promise<string> {
  const cacheRoot = cacheRootForBuild(metadata);
  const workerDirectory = join(cacheRoot, "__desktop-worker");
  const markerPath = join(workerDirectory, ".complete");
  const workerPath = join(workerDirectory, "worker.js");
  const tslibPath = join(workerDirectory, "node_modules", "tslib", "tslib.js");

  try {
    await stat(markerPath);
    await stat(workerPath);
    await stat(tslibPath);
    return workerPath;
  } catch {
    // continue and build the cache
  }

  const parentDirectory = dirname(workerDirectory);
  await mkdir(parentDirectory, { recursive: true });
  await rm(workerDirectory, { recursive: true, force: true });

  const tempDirectory = await mkdtemp(join(parentDirectory, "worker-"));

  try {
    const buffer = asar.extractFile(metadata.appAsarPath, ".vite/build/worker.js");
    await writeFile(join(tempDirectory, "worker.js"), buffer);
    await extractAsarDirectory(
      metadata.appAsarPath,
      "/node_modules/tslib/",
      join(tempDirectory, "node_modules", "tslib"),
    );
    await writeFile(markerPathFor(tempDirectory), "ok");
    await promoteCacheDirectory(tempDirectory, workerDirectory, markerPath);
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw new Error("Failed to extract Codex desktop worker.js.", {
      cause: error instanceof Error ? error : undefined,
    });
  }

  return workerPath;
}

async function ensurePocodexWebviewPatches(webviewRoot: string): Promise<void> {
  const markerPath = join(webviewRoot, ".pocodex-webview-patches-v1");
  try {
    await stat(markerPath);
    return;
  } catch {
    // Continue and apply the current patch set.
  }

  await patchUseAuthBundle(webviewRoot);
  await writeFile(markerPath, "ok");
}

async function patchUseAuthBundle(webviewRoot: string): Promise<void> {
  const assetsDirectory = join(webviewRoot, "assets");
  const entries = await readdir(assetsDirectory, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^use-auth-.*\.js$/i.test(entry.name))
      .map(async (entry) => {
        const assetPath = join(assetsDirectory, entry.name);
        const source = await readFile(assetPath, "utf8");
        const patched = patchUseAuthBundleSource(source);
        if (patched !== source) {
          await writeFile(assetPath, patched, "utf8");
        }
      }),
  );
}

function patchUseAuthBundleSource(source: string): string {
  const snapshotGetter =
    'window.electronBridge?.getSharedObjectSnapshotValue?.("pocodex_auth_state")';
  const patchedHookSnippet = `accountId:${snapshotGetter}?.accountId??null,userId:${snapshotGetter}?.userId??null`;
  const patchedContextReturn = `let t=${snapshotGetter}??null;return t&&typeof t===\`object\`?{...e,accountId:e.accountId??t.accountId??null,email:e.email??t.email??null,userId:e.userId??t.userId??null}:e}`;
  if (source.includes(patchedHookSnippet) && source.includes(patchedContextReturn)) {
    return source;
  }

  let patched = source.replace("accountId:null,userId:null", patchedHookSnippet);
  patched = patched.replace(
    "return e}function E(e){return D(s(e))}",
    `${patchedContextReturn}function E(e){return D(s(e))}`,
  );
  patched = patched.replace(
    "return e}function w(e){return T(s(e))}",
    `${patchedContextReturn}function w(e){return T(s(e))}`,
  );
  return patched;
}

async function resolveWebviewFaviconHref(webviewRoot: string): Promise<string | null> {
  const assetsDirectory = join(webviewRoot, "assets");
  const entries = await readdir(assetsDirectory, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return null;
  }

  const faviconCandidate = entries.find(
    (entry) => entry.isFile() && /^app-.*\.(?:png|svg|ico)$/i.test(entry.name),
  );

  return faviconCandidate ? `./assets/${faviconCandidate.name}` : null;
}

function cacheRootForBuild(
  metadata: Pick<CodexDesktopMetadata, "version" | "buildFlavor" | "buildNumber">,
): string {
  const directoryName = [
    sanitizeCachePathComponent(metadata.version),
    sanitizeCachePathComponent(metadata.buildFlavor),
    sanitizeCachePathComponent(metadata.buildNumber),
  ].join("__");
  return join(homedir(), ".cache", "pocodex", directoryName);
}

function sanitizeCachePathComponent(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "unknown";
}

function markerPathFor(directory: string): string {
  return join(directory, ".complete");
}

async function extractAsarText(appAsarPath: string, filename: string): Promise<string> {
  const buffer = asar.extractFile(appAsarPath, filename);
  return buffer.toString("utf8");
}

async function extractAsarDirectory(
  appAsarPath: string,
  archivePrefix: string,
  destinationDirectory: string,
): Promise<void> {
  const archiveEntries = asar.listPackage(appAsarPath, { isPack: false });

  for (const archiveEntry of archiveEntries) {
    if (!archiveEntry.startsWith(archivePrefix)) {
      continue;
    }

    const relativePath = archiveEntry.slice(archivePrefix.length);
    if (!relativePath) {
      continue;
    }

    const entry = asar.statFile(appAsarPath, archiveEntry.slice(1), false);
    if ("files" in entry || "link" in entry) {
      continue;
    }

    const destinationPath = join(destinationDirectory, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    const buffer = asar.extractFile(appAsarPath, archiveEntry.slice(1));
    await writeFile(destinationPath, buffer);
  }
}

async function resolveCodexDesktopPaths(appPath: string): Promise<ResolvedCodexDesktopPaths> {
  const normalizedAppPath = normalizeCodexAppPath(appPath);
  const candidates = buildDesktopPathCandidates(normalizedAppPath);

  for (const candidate of candidates) {
    if (await isValidDesktopPathCandidate(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      `Unable to locate a Codex desktop install from ${normalizedAppPath}.`,
      "Expected either a macOS bundle like /Applications/Codex.app",
      "or a Windows install root like /mnt/c/Program Files/WindowsApps/OpenAI.Codex_.../app.",
    ].join(" "),
  );
}

function normalizeCodexAppPath(appPath: string): string {
  const trimmedPath = appPath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("Codex app path cannot be empty.");
  }

  if (isWindowsAbsolutePath(trimmedPath)) {
    if (!isRunningInWsl()) {
      throw new Error(
        "Windows-style Codex app paths are supported when Pocodex is running inside WSL.",
      );
    }
    return resolve(convertWindowsPathToWsl(trimmedPath));
  }

  return resolve(trimmedPath);
}

function buildDesktopPathCandidates(appPath: string): ResolvedCodexDesktopPaths[] {
  const candidates: ResolvedCodexDesktopPaths[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: ResolvedCodexDesktopPaths) => {
    const key = `${candidate.layout}:${candidate.appPath}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const lowercaseBasename = basename(appPath).toLowerCase();
  if (lowercaseBasename === "codex" || lowercaseBasename === "codex.exe") {
    addCandidate(buildWindowsDesktopPaths(dirname(dirname(appPath))));
    addCandidate(buildMacDesktopPaths(dirname(dirname(dirname(appPath)))));
  }

  addCandidate(buildMacDesktopPaths(appPath));
  addCandidate(buildWindowsDesktopPaths(appPath));
  return candidates;
}

function buildMacDesktopPaths(appPath: string): ResolvedCodexDesktopPaths {
  return {
    appPath,
    appAsarPath: join(appPath, "Contents", "Resources", "app.asar"),
    cliBinaryPath: join(appPath, "Contents", "Resources", "codex"),
    infoPlistPath: join(appPath, "Contents", "Info.plist"),
    layout: "macos-app",
  };
}

function buildWindowsDesktopPaths(appPath: string): ResolvedCodexDesktopPaths {
  return {
    appPath,
    appAsarPath: join(appPath, "resources", "app.asar"),
    cliBinaryPath:
      process.platform === "win32"
        ? join(appPath, "resources", "codex.exe")
        : join(appPath, "resources", "codex"),
    layout: "windows-app",
  };
}

async function isValidDesktopPathCandidate(candidate: ResolvedCodexDesktopPaths): Promise<boolean> {
  if (!(await pathExists(candidate.appAsarPath)) || !(await pathExists(candidate.cliBinaryPath))) {
    return false;
  }

  if (candidate.infoPlistPath && !(await pathExists(candidate.infoPlistPath))) {
    return false;
  }

  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverWindowsStoreCodexApps(): Promise<string[]> {
  if (!isRunningInWsl()) {
    return [];
  }

  const discoveredByAppx = await discoverWindowsStoreCodexAppsFromAppx();
  if (discoveredByAppx.length > 0) {
    return discoveredByAppx;
  }

  const windowsAppsRoot = "/mnt/c/Program Files/WindowsApps";
  const entries = await readdir(windowsAppsRoot, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return [];
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return entries
    .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name))
    .map((entry) => join(windowsAppsRoot, entry.name, "app"))
    .sort((left, right) => collator.compare(right, left));
}

async function discoverWindowsStoreCodexAppsFromAppx(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation)",
    ]);

    const installLocations = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return installLocations.map((installLocation) =>
      resolve(convertWindowsPathToWsl(`${installLocation}\\app`)),
    );
  } catch {
    return [];
  }
}

function isRunningInWsl(): boolean {
  return (
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function convertWindowsPathToWsl(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path;
  }

  const driveLetter = match[1].toLowerCase();
  const relativePath = match[2].replaceAll("\\", "/");
  return `/mnt/${driveLetter}/${relativePath}`;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function promoteCacheDirectory(
  tempDirectory: string,
  destinationDirectory: string,
  markerPath: string,
): Promise<void> {
  try {
    await rename(tempDirectory, destinationDirectory);
    return;
  } catch (error) {
    if (await pathExists(markerPath)) {
      await rm(tempDirectory, { recursive: true, force: true });
      return;
    }

    if (isRenameConflictError(error)) {
      await rm(destinationDirectory, { recursive: true, force: true });
      await rename(tempDirectory, destinationDirectory);
      return;
    }

    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

function isRenameConflictError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}
