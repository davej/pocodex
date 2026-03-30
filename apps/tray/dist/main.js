import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import todesktop from "@todesktop/runtime";
import { Menu, Tray, app, clipboard, dialog, nativeImage, shell, } from "electron";
import { DEFAULT_POCODEX_APP_PATH, createPocodexRuntime } from "pocodex";
import { chooseCodexAppPath } from "./app-path.js";
import { applySelectedCodexAppPath, buildRuntimeOptions, generateTrayToken, getDefaultTrayConfig, loadTrayConfig, planLanAccessChange, saveTrayConfig, shouldRestartForConfigChange, } from "./config.js";
import { buildTrayMenuTemplate } from "./menu.js";
todesktop.init();
let config = getDefaultTrayConfig();
let configPath = "";
let runtime = null;
let snapshot = {
    ...buildRuntimeOptions(config),
    codexVersion: null,
    lastError: null,
    localOpenUrl: null,
    localUrl: null,
    networkOpenUrl: null,
    networkUrl: null,
    state: "stopped",
    tokenConfigured: false,
};
let tray = null;
let runtimeErrorListener = null;
let runtimeSnapshotListener = null;
const startupLogPath = join(process.env.HOME || process.cwd(), "Library", "Logs", "pocodex-tray.log");
process.on("uncaughtException", (error) => {
    logStartup(`uncaughtException: ${error.stack ?? error.message}`);
});
process.on("unhandledRejection", (reason) => {
    logStartup(`unhandledRejection: ${String(reason)}`);
});
logStartup("main module loaded");
logStartup("todesktop runtime initialized");
app.on("window-all-closed", () => {
    // Tray app stays resident without any BrowserWindow instances.
});
void bootstrap().catch((error) => {
    logStartup(`bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
async function bootstrap() {
    await app.whenReady();
    logStartup("app.whenReady resolved");
    if (process.platform === "darwin") {
        const appIcon = createAppIcon();
        if (app.dock) {
            app.dock.setIcon(appIcon);
            logStartup("dock icon set");
        }
        app.setActivationPolicy("accessory");
        logStartup("activation policy set to accessory");
    }
    if (app.dock) {
        app.dock.hide();
        logStartup("dock hidden");
    }
    configPath = join(app.getPath("userData"), "config.json");
    logStartup(`config path: ${configPath}`);
    config = await loadTrayConfig(configPath);
    await saveTrayConfig(configPath, config);
    logStartup(`config loaded; autoStart=${String(config.autoStart)}`);
    tray = new Tray(createTrayIcon());
    tray.setToolTip("Pocodex");
    logStartup("tray created");
    await replaceRuntime(false);
    rebuildMenu();
    logStartup("runtime initialized in stopped state");
    if (config.autoStart) {
        void startRuntimeInBackground();
        logStartup("background runtime start requested");
    }
}
async function replaceRuntime(shouldStart) {
    logStartup(`replaceRuntime called; shouldStart=${String(shouldStart)}`);
    if (runtime) {
        if (runtimeErrorListener) {
            runtime.off?.("error", runtimeErrorListener);
        }
        if (runtimeSnapshotListener) {
            runtime.off?.("snapshot", runtimeSnapshotListener);
        }
        await runtime.stop().catch(() => undefined);
    }
    runtime = createPocodexRuntime(buildRuntimeOptions(config));
    logStartup("runtime created");
    snapshot = runtime.getSnapshot();
    runtimeSnapshotListener = (nextSnapshot) => {
        snapshot = nextSnapshot;
        logStartup(`snapshot: ${snapshot.state}`);
        rebuildMenu();
    };
    runtimeErrorListener = () => {
        snapshot = runtime?.getSnapshot() ?? snapshot;
        logStartup(`runtime error snapshot: ${snapshot.lastError ?? "unknown"}`);
        rebuildMenu();
    };
    runtime.on("snapshot", runtimeSnapshotListener);
    runtime.on("error", runtimeErrorListener);
    rebuildMenu();
    if (shouldStart) {
        await runtime.start().catch(() => undefined);
    }
}
async function startRuntimeInBackground() {
    if (!runtime) {
        return;
    }
    logStartup("background runtime start entered");
    await runtime.start().catch(() => undefined);
    logStartup("background runtime start settled");
}
function rebuildMenu() {
    if (!tray) {
        return;
    }
    const handlers = {
        chooseCodexApp: () => {
            void updateCodexAppPath();
        },
        copyLanUrl: () => {
            if (snapshot.networkUrl) {
                clipboard.writeText(snapshot.networkUrl);
            }
        },
        copyLocalUrl: () => {
            if (snapshot.localUrl) {
                clipboard.writeText(snapshot.localUrl);
            }
        },
        openPocodex: () => {
            if (snapshot.localOpenUrl) {
                void shell.openExternal(snapshot.localOpenUrl);
            }
        },
        quit: () => {
            void quitApp();
        },
        regenerateLanToken: () => {
            void updateConfig({
                ...config,
                token: generateTrayToken(),
            });
        },
        resetCodexAppPath: () => {
            void updateConfig({
                ...config,
                appPath: DEFAULT_POCODEX_APP_PATH,
            });
        },
        restartPocodex: () => {
            void restartRuntime();
        },
        revealConfigFile: () => {
            void saveTrayConfig(configPath, config).then(() => {
                shell.showItemInFolder(configPath);
            });
        },
        setLanAccess: (enabled) => {
            const planned = planLanAccessChange(config, snapshot, enabled);
            void updateConfig(planned.config, planned.restartRequired);
        },
        startPocodex: () => {
            void runtime?.start().catch(() => undefined);
        },
        stopPocodex: () => {
            void runtime?.stop().catch(() => undefined);
        },
    };
    const template = buildTrayMenuTemplate(config, snapshot, handlers);
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(buildTooltip(snapshot));
}
async function restartRuntime() {
    if (!runtime) {
        return;
    }
    await runtime.restart(buildRuntimeOptions(config)).catch(() => undefined);
}
async function updateConfig(nextConfig, shouldRestart = shouldRestartForConfigChange(snapshot)) {
    config = nextConfig;
    await saveTrayConfig(configPath, config);
    if (shouldRestart) {
        await replaceRuntime(true);
        return;
    }
    await replaceRuntime(false);
}
async function updateCodexAppPath() {
    const selectedPath = await chooseCodexAppPath(() => dialog.showOpenDialog({
        defaultPath: config.appPath,
        properties: ["openDirectory"],
        title: "Choose Codex.app",
    }));
    if (!selectedPath) {
        return;
    }
    await updateConfig(applySelectedCodexAppPath(config, selectedPath), true);
}
async function quitApp() {
    await runtime?.stop().catch(() => undefined);
    app.quit();
}
function buildTooltip(currentSnapshot) {
    const lines = [`Pocodex (${currentSnapshot.state})`];
    if (currentSnapshot.localUrl) {
        lines.push(currentSnapshot.localUrl);
    }
    if (currentSnapshot.lastError) {
        lines.push(currentSnapshot.lastError);
    }
    return lines.join("\n");
}
function createTrayIcon() {
    logStartup("creating tray icon");
    const icon = nativeImage.createFromPath(fileURLToPath(new URL("../assets/tray-template.png", import.meta.url)));
    icon.addRepresentation({
        buffer: readFileSync(fileURLToPath(new URL("../assets/tray-template@2x.png", import.meta.url))),
        height: 36,
        scaleFactor: 2,
        width: 36,
    });
    icon.setTemplateImage(true);
    logStartup(`tray icon empty=${String(icon.isEmpty())}`);
    return icon;
}
function createAppIcon() {
    const icon = nativeImage.createFromPath(fileURLToPath(new URL("../assets/app-icon.png", import.meta.url)));
    logStartup(`app icon empty=${String(icon.isEmpty())}`);
    return icon;
}
function logStartup(message) {
    try {
        appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
    }
    catch {
        // Best-effort logging only.
    }
}
