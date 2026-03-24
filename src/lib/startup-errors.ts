import { basename, join } from "node:path";

export function deriveCodexCliBinaryPath(appPath: string, appServerPath?: string): string {
  if (appServerPath) {
    return appServerPath;
  }

  if (basename(appPath) === "codex") {
    return appPath;
  }
  return join(appPath, "Contents", "Resources", "codex");
}
