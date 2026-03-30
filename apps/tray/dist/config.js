import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_POCODEX_APP_PATH } from "pocodex";
export function getDefaultTrayConfig() {
    return {
        appPath: DEFAULT_POCODEX_APP_PATH,
        autoStart: true,
        listenMode: "loopback",
        listenPort: 0,
        token: "",
    };
}
export async function loadTrayConfig(configPath) {
    try {
        const rawConfig = JSON.parse(await readFile(configPath, "utf8"));
        return normalizeTrayConfig(rawConfig);
    }
    catch (error) {
        if (isMissingFileError(error)) {
            return getDefaultTrayConfig();
        }
        throw error;
    }
}
export async function saveTrayConfig(configPath, config) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(`${configPath}`, `${JSON.stringify(normalizeTrayConfig(config), null, 2)}\n`, "utf8");
}
export function normalizeTrayConfig(value) {
    const defaults = getDefaultTrayConfig();
    if (!isRecord(value)) {
        return defaults;
    }
    return {
        appPath: typeof value.appPath === "string" && value.appPath.trim().length > 0
            ? value.appPath.trim()
            : defaults.appPath,
        autoStart: true,
        listenMode: value.listenMode === "lan" ? "lan" : "loopback",
        listenPort: 0,
        token: typeof value.token === "string" ? value.token : defaults.token,
    };
}
export function buildRuntimeOptions(config) {
    return {
        appPath: config.appPath,
        cwd: process.env.HOME || process.cwd(),
        devMode: false,
        listenHost: config.listenMode === "lan" ? "0.0.0.0" : "127.0.0.1",
        listenPort: config.listenPort,
        token: config.listenMode === "lan" ? config.token : "",
    };
}
export function enableLanAccess(config) {
    return {
        ...config,
        listenMode: "lan",
        token: config.token || generateTrayToken(),
    };
}
export function disableLanAccess(config) {
    return {
        ...config,
        listenMode: "loopback",
    };
}
export function shouldRestartForConfigChange(snapshot) {
    return snapshot.state !== "stopped";
}
export function planLanAccessChange(config, snapshot, enabled) {
    return {
        config: enabled ? enableLanAccess(config) : disableLanAccess(config),
        restartRequired: shouldRestartForConfigChange(snapshot),
    };
}
export function applySelectedCodexAppPath(config, selectedPath) {
    if (!selectedPath) {
        return config;
    }
    return {
        ...config,
        appPath: selectedPath,
    };
}
export function generateTrayToken() {
    return randomBytes(16).toString("hex");
}
function isMissingFileError(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
