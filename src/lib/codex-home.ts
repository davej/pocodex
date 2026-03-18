import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export function deriveCodexHomePath(): string {
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return configuredCodexHome;
  }

  const windowsUserProfile = process.env.USERPROFILE?.trim();
  if ((process.platform === "win32" || isRunningInWsl()) && windowsUserProfile) {
    return join(windowsUserProfile, ".codex");
  }

  return join(homedir(), ".codex");
}

function isRunningInWsl(): boolean {
  return (
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}
