import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { AppServerBridge } from "./app-server-bridge.js";
import { renderBootstrapScript } from "./bootstrap-script.js";
import { loadCodexBundle } from "./codex-bundle.js";
import { patchIndexHtml } from "./html-patcher.js";
import { renderPwaHeadTags, renderServiceWorkerScript, renderWebManifest } from "./pwa.js";
import type { HostBridge, SentryInitOptions } from "./protocol.js";
import { getServeUrls } from "./serve-url.js";
import { PocodexServer } from "./server.js";

export const DEFAULT_POCODEX_APP_PATH = "/Applications/Codex.app";
const POCODEX_BACKGROUND_COLOR = "#111827";
const POCODEX_MANIFEST_HREF = "/manifest.webmanifest";
const POCODEX_PWA_APP_NAME = "Pocodex";
const POCODEX_PWA_DESCRIPTION = "Run the Codex desktop webview in an installable browser shell.";
const POCODEX_SERVICE_WORKER_HREF = "/service-worker.js";
const POCODEX_STYLESHEET_HREF = "/pocodex.css";
const POCODEX_THEME_COLOR = "#111827";

export type PocodexState = "starting" | "running" | "stopped" | "error";

export interface PocodexRuntimeOptions {
  appPath: string;
  cwd: string;
  devMode: boolean;
  listenHost: string;
  listenPort: number;
  token: string;
}

export interface PocodexSnapshot {
  state: PocodexState;
  appPath: string;
  codexVersion: string | null;
  lastError: string | null;
  listenHost: string;
  listenPort: number;
  localOpenUrl: string | null;
  localUrl: string | null;
  networkOpenUrl: string | null;
  networkUrl: string | null;
  tokenConfigured: boolean;
}

export interface PocodexRuntime {
  getSnapshot(): PocodexSnapshot;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "snapshot", listener: (snapshot: PocodexSnapshot) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "snapshot", listener: (snapshot: PocodexSnapshot) => void): this;
  restart(nextOptions?: Partial<PocodexRuntimeOptions>): Promise<PocodexSnapshot>;
  start(): Promise<PocodexSnapshot>;
  stop(): Promise<void>;
}

interface ActiveRuntimeResources {
  relay: HostBridge;
  relayErrorListener: (error: Error) => void;
  server: PocodexServer;
  stopWatchingStylesheet: () => void;
}

class ManagedPocodexRuntime extends EventEmitter implements PocodexRuntime {
  private activeResources: ActiveRuntimeResources | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private options: PocodexRuntimeOptions;
  private snapshot: PocodexSnapshot;

  constructor(options: PocodexRuntimeOptions) {
    super();
    this.options = { ...options };
    this.snapshot = createInitialSnapshot(options);
  }

  override off(event: "error", listener: (error: Error) => void): this;
  override off(event: "snapshot", listener: (snapshot: PocodexSnapshot) => void): this;
  override off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: "snapshot", listener: (snapshot: PocodexSnapshot) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  getSnapshot(): PocodexSnapshot {
    return { ...this.snapshot };
  }

  start(): Promise<PocodexSnapshot> {
    return this.enqueue(() => this.startInternal());
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.stopInternal();
    });
  }

  restart(nextOptions?: Partial<PocodexRuntimeOptions>): Promise<PocodexSnapshot> {
    return this.enqueue(async () => {
      if (nextOptions) {
        this.options = {
          ...this.options,
          ...nextOptions,
        };
        this.updateSnapshot({
          appPath: this.options.appPath,
          listenHost: this.options.listenHost,
          listenPort: this.options.listenPort,
          tokenConfigured: this.options.token.length > 0,
        });
      }

      await this.stopInternal();
      return this.startInternal();
    });
  }

  private async startInternal(): Promise<PocodexSnapshot> {
    if (this.snapshot.state === "running") {
      return this.getSnapshot();
    }

    await this.disposeResources();
    this.updateSnapshot({
      appPath: this.options.appPath,
      codexVersion: null,
      lastError: null,
      listenHost: this.options.listenHost,
      listenPort: this.options.listenPort,
      localOpenUrl: null,
      localUrl: null,
      networkOpenUrl: null,
      networkUrl: null,
      state: "starting",
      tokenConfigured: this.options.token.length > 0,
    });

    let relay: HostBridge | null = null;
    let server: PocodexServer | null = null;
    let relayErrorListener: ((error: Error) => void) | null = null;
    let stopWatchingStylesheet = () => {};

    try {
      const bundle = await loadCodexBundle(this.options.appPath);
      const pocodexCssPath = fileURLToPath(new URL("../pocodex.css", import.meta.url));
      const importIconSvgPath = fileURLToPath(new URL("../images/import.svg", import.meta.url));

      relay = await AppServerBridge.connect({
        appPath: this.options.appPath,
        cwd: this.options.cwd,
      });

      relayErrorListener = (error) => {
        void this.handleBackgroundError(error);
      };
      relay.on("error", relayErrorListener);

      const sentryOptions: SentryInitOptions = {
        buildFlavor: bundle.buildFlavor,
        appVersion: bundle.version,
        buildNumber: bundle.buildNumber,
        codexAppSessionId: randomUUID(),
      };
      const pwaConfig = {
        appName: POCODEX_PWA_APP_NAME,
        shortName: POCODEX_PWA_APP_NAME,
        description: POCODEX_PWA_DESCRIPTION,
        themeColor: POCODEX_THEME_COLOR,
        backgroundColor: POCODEX_BACKGROUND_COLOR,
        manifestPath: POCODEX_MANIFEST_HREF,
        iconHref: bundle.faviconHref,
      };

      server = new PocodexServer({
        listenHost: this.options.listenHost,
        listenPort: this.options.listenPort,
        token: this.options.token,
        relay,
        webviewRoot: bundle.webviewRoot,
        readPocodexStylesheet: async () => readFile(pocodexCssPath, "utf8"),
        renderIndexHtml: async () => {
          const indexHtml = await bundle.readIndexHtml();
          return patchIndexHtml(indexHtml, {
            bootstrapScript: renderBootstrapScript({
              devMode: this.options.devMode,
              sentryOptions,
              stylesheetHref: POCODEX_STYLESHEET_HREF,
              importIconSvg: await readFile(importIconSvgPath, "utf8"),
            }),
            faviconHref: bundle.faviconHref,
            headTags: renderPwaHeadTags(pwaConfig),
            stylesheetHref: POCODEX_STYLESHEET_HREF,
          });
        },
        renderWebManifest: async () => renderWebManifest(pwaConfig),
        renderServiceWorkerScript: async () =>
          renderServiceWorkerScript({
            cacheName: `pocodex-shell:${bundle.version}:${bundle.buildNumber}`,
            indexPath: "/index.html",
            serviceWorkerPath: POCODEX_SERVICE_WORKER_HREF,
          }),
      });

      stopWatchingStylesheet = this.options.devMode
        ? watchPocodexStylesheet(pocodexCssPath, () => {
            server?.notifyStylesheetReload(String(Date.now()));
          })
        : () => {};

      await server.listen();

      const listeningAddress = server.getAddress();
      const serveUrls = getServeUrls({
        listenHost: this.options.listenHost,
        listenPort: listeningAddress.port,
        token: this.options.token,
      });

      this.activeResources = {
        relay,
        relayErrorListener,
        server,
        stopWatchingStylesheet,
      };
      this.updateSnapshot({
        appPath: bundle.appPath,
        codexVersion: bundle.version,
        lastError: null,
        listenHost: this.options.listenHost,
        listenPort: listeningAddress.port,
        localOpenUrl: serveUrls.localOpenUrl,
        localUrl: serveUrls.localUrl,
        networkOpenUrl: serveUrls.networkOpenUrl ?? null,
        networkUrl: serveUrls.networkUrl ?? null,
        state: "running",
        tokenConfigured: this.options.token.length > 0,
      });
      return this.getSnapshot();
    } catch (error) {
      stopWatchingStylesheet();
      if (server) {
        await server.close().catch(() => undefined);
      }
      if (relay && relayErrorListener) {
        relay.off?.("error", relayErrorListener);
      }
      if (relay) {
        await relay.close().catch(() => undefined);
      }

      const normalized = normalizeError(error);
      this.activeResources = null;
      this.updateSnapshot({
        codexVersion: null,
        lastError: normalized.message,
        listenPort: this.options.listenPort,
        localOpenUrl: null,
        localUrl: null,
        networkOpenUrl: null,
        networkUrl: null,
        state: "error",
        tokenConfigured: this.options.token.length > 0,
      });
      this.emit("error", normalized);
      throw normalized;
    }
  }

  private async stopInternal(): Promise<void> {
    await this.disposeResources();
    this.updateSnapshot({
      appPath: this.options.appPath,
      lastError: null,
      listenHost: this.options.listenHost,
      listenPort: this.options.listenPort,
      localOpenUrl: null,
      localUrl: null,
      networkOpenUrl: null,
      networkUrl: null,
      state: "stopped",
      tokenConfigured: this.options.token.length > 0,
    });
  }

  private async handleBackgroundError(error: Error): Promise<void> {
    if (!this.activeResources) {
      return;
    }

    const normalized = normalizeError(error);
    await this.disposeResources();
    this.updateSnapshot({
      lastError: normalized.message,
      localOpenUrl: null,
      localUrl: null,
      networkOpenUrl: null,
      networkUrl: null,
      state: "error",
    });
    this.emit("error", normalized);
  }

  private async disposeResources(): Promise<void> {
    const activeResources = this.activeResources;
    this.activeResources = null;
    if (!activeResources) {
      return;
    }

    activeResources.stopWatchingStylesheet();
    activeResources.relay.off?.("error", activeResources.relayErrorListener);
    await activeResources.server.close().catch(() => undefined);
    await activeResources.relay.close().catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const nextOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }

  private updateSnapshot(next: Partial<PocodexSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...next,
    };
    this.emit("snapshot", this.getSnapshot());
  }
}

export function createPocodexRuntime(options: PocodexRuntimeOptions): PocodexRuntime {
  return new ManagedPocodexRuntime(options);
}

function createInitialSnapshot(options: PocodexRuntimeOptions): PocodexSnapshot {
  return {
    appPath: options.appPath,
    codexVersion: null,
    lastError: null,
    listenHost: options.listenHost,
    listenPort: options.listenPort,
    localOpenUrl: null,
    localUrl: null,
    networkOpenUrl: null,
    networkUrl: null,
    state: "stopped",
    tokenConfigured: options.token.length > 0,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function watchPocodexStylesheet(cssFilePath: string, onChange: () => void): () => void {
  const cssDirectory = dirname(cssFilePath);
  const cssFilename = basename(cssFilePath);
  let debounceTimer: NodeJS.Timeout | undefined;

  const watcher: FSWatcher = watch(cssDirectory, (_eventType, changedFilename) => {
    const changedName = changedFilename ? String(changedFilename) : undefined;
    if (changedName && changedName !== cssFilename) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      onChange();
    }, 50);
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}
