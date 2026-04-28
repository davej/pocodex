import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export function deriveCodexHomePath(): string {
  return listCodexHomePathCandidates()[0] ?? join(homedir(), ".codex");
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
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
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
