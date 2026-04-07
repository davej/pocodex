import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import {
  DEFAULT_POCODEX_APP_PATH,
  createPocodexRuntime,
  type PocodexRuntime,
  type PocodexSnapshot,
} from "pocodex";

import { chooseCodexAppPath } from "./app-path.js";
import { getClipboardUrl } from "./copy-url.js";
import { shouldInitTodesktopRuntime } from "./todesktop-runtime.js";
import {
  applySelectedCodexAppPath,
  buildRuntimeOptions,
  ensureTrayConfigHasToken,
  generateTrayToken,
  getDefaultTrayConfig,
  loadTrayConfig,
  planLanAccessChange,
  saveTrayConfig,
  shouldRestartForConfigChange,
  type TrayConfig,
} from "./config.js";
import { buildTrayMenuTemplate, type TrayMenuHandlers } from "./menu.js";

const require = createRequire(import.meta.url);
const shouldLoadTodesktopRuntime = shouldInitTodesktopRuntime({
  enableRuntimeEnv: process.env.POCODEX_ENABLE_TODESKTOP_RUNTIME,
  isPackaged: app.isPackaged,
  smokeTestEnv: process.env.TODESKTOP_SMOKE_TEST,
});

if (shouldLoadTodesktopRuntime) {
  const todesktop = require("@todesktop/runtime");
  todesktop.init();
}

let config = getDefaultTrayConfig();
let configPath = "";
let runtime: PocodexRuntime | null = null;
let snapshot: PocodexSnapshot = {
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
let tray: Tray | null = null;
let runtimeErrorListener: ((error: Error) => void) | null = null;
let runtimeSnapshotListener: ((nextSnapshot: PocodexSnapshot) => void) | null = null;
const startupLogPath = join(
  process.env.HOME || process.cwd(),
  "Library",
  "Logs",
  "pocodex-tray.log",
);

process.on("uncaughtException", (error) => {
  logStartup(`uncaughtException: ${error.stack ?? error.message}`);
});
process.on("unhandledRejection", (reason) => {
  logStartup(`unhandledRejection: ${String(reason)}`);
});

logStartup("main module loaded");
logStartup(
  shouldLoadTodesktopRuntime
    ? "todesktop runtime initialized"
    : "todesktop runtime skipped for local development",
);

app.on("window-all-closed", () => {
  // Tray app stays resident without any BrowserWindow instances.
});

void bootstrap().catch((error) => {
  logStartup(
    `bootstrap failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
});

async function bootstrap(): Promise<void> {
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
  config = ensureTrayConfigHasToken(await loadTrayConfig(configPath));
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

async function replaceRuntime(shouldStart: boolean): Promise<void> {
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
    persistRuntimeListenPort(nextSnapshot);
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

async function startRuntimeInBackground(): Promise<void> {
  if (!runtime) {
    return;
  }

  logStartup("background runtime start entered");
  await runtime.start().catch(() => undefined);
  logStartup("background runtime start settled");
}

function rebuildMenu(): void {
  if (!tray) {
    return;
  }

  const handlers: TrayMenuHandlers = {
    chooseCodexApp: () => {
      void updateCodexAppPath();
    },
    copyLanUrl: () => {
      const url = getClipboardUrl(snapshot, "network");
      if (url) {
        clipboard.writeText(url);
      }
    },
    copyLocalUrl: () => {
      const url = getClipboardUrl(snapshot, "local");
      if (url) {
        clipboard.writeText(url);
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
    regenerateAccessToken: () => {
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

  const template: MenuItemConstructorOptions[] = buildTrayMenuTemplate(config, snapshot, handlers);
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(buildTooltip(snapshot));
}

async function restartRuntime(): Promise<void> {
  if (!runtime) {
    return;
  }
  await runtime.restart(buildRuntimeOptions(config)).catch(() => undefined);
}

async function updateConfig(
  nextConfig: TrayConfig,
  shouldRestart = shouldRestartForConfigChange(snapshot),
): Promise<void> {
  config = nextConfig;
  await saveTrayConfig(configPath, config);

  if (shouldRestart) {
    await replaceRuntime(true);
    return;
  }

  await replaceRuntime(false);
}

async function updateCodexAppPath(): Promise<void> {
  const selectedPath = await chooseCodexAppPath(() =>
    dialog.showOpenDialog({
      defaultPath: config.appPath,
      properties: ["openDirectory"],
      title: "Choose Codex.app",
    }),
  );
  if (!selectedPath) {
    return;
  }

  await updateConfig(applySelectedCodexAppPath(config, selectedPath), true);
}

async function quitApp(): Promise<void> {
  await runtime?.stop().catch(() => undefined);
  app.quit();
}

function buildTooltip(currentSnapshot: PocodexSnapshot): string {
  const lines = [`Pocodex (${currentSnapshot.state})`];
  if (currentSnapshot.localUrl) {
    lines.push(currentSnapshot.localUrl);
  }
  if (currentSnapshot.lastError) {
    lines.push(currentSnapshot.lastError);
  }
  return lines.join("\n");
}

function persistRuntimeListenPort(nextSnapshot: PocodexSnapshot): void {
  if (nextSnapshot.state !== "running") {
    return;
  }
  if (!Number.isInteger(nextSnapshot.listenPort) || nextSnapshot.listenPort <= 0) {
    return;
  }
  if (config.listenPort === nextSnapshot.listenPort) {
    return;
  }

  config = {
    ...config,
    listenPort: nextSnapshot.listenPort,
  };
  void saveTrayConfig(configPath, config).catch(() => undefined);
}

function createTrayIcon() {
  logStartup("creating tray icon");
  const icon = nativeImage.createFromPath(
    fileURLToPath(new URL("../assets/tray-template.png", import.meta.url)),
  );
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
  const icon = nativeImage.createFromPath(
    fileURLToPath(new URL("../assets/app-icon.png", import.meta.url)),
  );
  logStartup(`app icon empty=${String(icon.isEmpty())}`);
  return icon;
}

function logStartup(message: string): void {
  try {
    appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Best-effort logging only.
  }
}
