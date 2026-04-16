import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export function deriveCodexHomePath(): string {
  return listCodexHomePathCandidates()[0] ?? join(homedir(), ".codex");
}

export function deriveBrowserCodexHomePath(): string {
  const configuredCodexHome = normalizeEnvironmentPath(process.env.CODEX_HOME);
  if (configuredCodexHome) {
    return configuredCodexHome;
  }

  if (!isRunningInWsl()) {
    return join(homedir(), ".codex");
  }

  // The desktop bundle assumes a single Codex home when filtering local threads.
  // In WSL we may surface sessions from both the Windows and Linux homes, so report
  // their shared ancestor to keep both sets visible in browser-side path checks.
  return deriveSharedAncestorPath(listCodexHomePathCandidates()) ?? deriveCodexHomePath();
}

export function listCodexHomePathCandidates(): string[] {
  const candidates: string[] = [];
  addPathCandidate(candidates, normalizeEnvironmentPath(process.env.CODEX_HOME));

  const windowsUserProfile =
    normalizeEnvironmentPath(process.env.USERPROFILE) ?? resolveWslWindowsUserProfile();
  if ((process.platform === "win32" || isRunningInWsl()) && windowsUserProfile) {
    addPathCandidate(candidates, join(windowsUserProfile, ".codex"));
  }

  addPathCandidate(candidates, join(homedir(), ".codex"));
  return candidates;
}

function isRunningInWsl(): boolean {
  return (
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}

function normalizeEnvironmentPath(path: string | undefined): string | null {
  const trimmedPath = path?.trim();
  if (!trimmedPath) {
    return null;
  }

  return isRunningInWsl() ? convertWindowsPathToWsl(trimmedPath) : trimmedPath;
}

function convertWindowsPathToWsl(path: string): string {
  const normalizedWslUncPath = convertWslUncPathToLinux(path);
  if (normalizedWslUncPath) {
    return normalizedWslUncPath;
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

function addPathCandidate(candidates: string[], candidate: string | null): void {
  if (!candidate || candidates.includes(candidate)) {
    return;
  }

  candidates.push(candidate);
}

function deriveSharedAncestorPath(paths: string[]): string | null {
  const normalizedPaths = paths
    .map((path) => normalizeSharedAncestorPath(path))
    .filter((path): path is string => path.length > 0);
  const [firstPath, ...remainingPaths] = normalizedPaths;
  if (!firstPath) {
    return null;
  }

  let sharedPath: string | null = firstPath;
  for (const path of remainingPaths) {
    sharedPath = deriveCommonAncestorPath(sharedPath, path);
    if (!sharedPath) {
      return null;
    }
  }

  return sharedPath;
}

function normalizeSharedAncestorPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  if (normalizedPath.length <= 1) {
    return normalizedPath;
  }

  return normalizedPath.replace(/\/+$/, "");
}

function deriveCommonAncestorPath(leftPath: string, rightPath: string): string | null {
  const leftIsAbsolute = leftPath.startsWith("/");
  if (leftIsAbsolute !== rightPath.startsWith("/")) {
    return null;
  }

  const leftSegments = leftPath.split("/").filter((segment) => segment.length > 0);
  const rightSegments = rightPath.split("/").filter((segment) => segment.length > 0);
  const sharedSegmentCount = Math.min(leftSegments.length, rightSegments.length);
  let segmentIndex = 0;
  while (
    segmentIndex < sharedSegmentCount &&
    leftSegments[segmentIndex] === rightSegments[segmentIndex]
  ) {
    segmentIndex += 1;
  }

  if (leftIsAbsolute) {
    return segmentIndex === 0 ? "/" : `/${leftSegments.slice(0, segmentIndex).join("/")}`;
  }

  if (segmentIndex === 0) {
    return null;
  }

  const sharedRelativePath = leftSegments.slice(0, segmentIndex).join("/");
  return /^[A-Za-z]:$/u.test(sharedRelativePath) ? `${sharedRelativePath}/` : sharedRelativePath;
}

function resolveWslWindowsUserProfile(): string | null {
  if (!isRunningInWsl()) {
    return null;
  }

  const resolvedFromCmd = readWindowsUserProfileFromCommand("cmd.exe", [
    "/d",
    "/c",
    "echo %USERPROFILE%",
  ]);
  if (resolvedFromCmd) {
    return resolvedFromCmd;
  }

  return readWindowsUserProfileFromCommand("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "[Environment]::GetFolderPath('UserProfile')",
  ]);
}

function readWindowsUserProfileFromCommand(command: string, args: string[]): string | null {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeEnvironmentPath(stdout);
  } catch {
    return null;
  }
}
