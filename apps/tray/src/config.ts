import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_POCODEX_APP_PATH,
  type PocodexRuntimeOptions,
  type PocodexSnapshot,
} from "pocodex";

export type TrayListenMode = "loopback" | "lan";

export interface TrayConfig {
  appPath: string;
  autoStart: true;
  listenMode: TrayListenMode;
  listenPort: 0;
  token: string;
}

export function getDefaultTrayConfig(): TrayConfig {
  return {
    appPath: DEFAULT_POCODEX_APP_PATH,
    autoStart: true,
    listenMode: "loopback",
    listenPort: 0,
    token: "",
  };
}

export async function loadTrayConfig(configPath: string): Promise<TrayConfig> {
  try {
    const rawConfig = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return normalizeTrayConfig(rawConfig);
  } catch (error) {
    if (isMissingFileError(error)) {
      return getDefaultTrayConfig();
    }
    throw error;
  }
}

export async function saveTrayConfig(configPath: string, config: TrayConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    `${configPath}`,
    `${JSON.stringify(normalizeTrayConfig(config), null, 2)}\n`,
    "utf8",
  );
}

export function normalizeTrayConfig(value: unknown): TrayConfig {
  const defaults = getDefaultTrayConfig();
  if (!isRecord(value)) {
    return defaults;
  }

  return {
    appPath:
      typeof value.appPath === "string" && value.appPath.trim().length > 0
        ? value.appPath.trim()
        : defaults.appPath,
    autoStart: true,
    listenMode: value.listenMode === "lan" ? "lan" : "loopback",
    listenPort: 0,
    token: typeof value.token === "string" ? value.token : defaults.token,
  };
}

export function buildRuntimeOptions(config: TrayConfig): PocodexRuntimeOptions {
  return {
    appPath: config.appPath,
    cwd: process.env.HOME || process.cwd(),
    devMode: false,
    listenHost: config.listenMode === "lan" ? "0.0.0.0" : "127.0.0.1",
    listenPort: config.listenPort,
    token: config.listenMode === "lan" ? config.token : "",
  };
}

export function enableLanAccess(config: TrayConfig): TrayConfig {
  return {
    ...config,
    listenMode: "lan",
    token: config.token || generateTrayToken(),
  };
}

export function disableLanAccess(config: TrayConfig): TrayConfig {
  return {
    ...config,
    listenMode: "loopback",
  };
}

export function shouldRestartForConfigChange(snapshot: PocodexSnapshot): boolean {
  return snapshot.state !== "stopped";
}

export function planLanAccessChange(
  config: TrayConfig,
  snapshot: PocodexSnapshot,
  enabled: boolean,
): { config: TrayConfig; restartRequired: boolean } {
  return {
    config: enabled ? enableLanAccess(config) : disableLanAccess(config),
    restartRequired: shouldRestartForConfigChange(snapshot),
  };
}

export function applySelectedCodexAppPath(
  config: TrayConfig,
  selectedPath: string | null,
): TrayConfig {
  if (!selectedPath) {
    return config;
  }

  return {
    ...config,
    appPath: selectedPath,
  };
}

export function generateTrayToken(): string {
  return randomBytes(16).toString("hex");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
