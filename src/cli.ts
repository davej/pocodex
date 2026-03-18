#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { AppServerBridge } from "./lib/app-server-bridge.js";
import { loadCodexBundle, resolveDefaultCodexAppPath } from "./lib/codex-bundle.js";
import { renderBootstrapScript } from "./lib/bootstrap-script.js";
import { patchIndexHtml } from "./lib/html-patcher.js";
import type { SentryInitOptions, ServeCommandOptions } from "./lib/protocol.js";
import { getServeUrls } from "./lib/serve-url.js";
import { PocodexServer } from "./lib/server.js";

const DEFAULT_LISTEN = "127.0.0.1:8787";
const POCODEX_STYLESHEET_HREF = "/pocodex.css";
const FLAG_NAMES_WITH_VALUES = new Set(["--app", "--listen", "--token"]);
const BOOLEAN_FLAG_NAMES = new Set(["--dev"]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command && command !== "serve" && !command.startsWith("--")) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const serveArgv = command === "serve" ? argv.slice(1) : argv;
  if (serveArgv.includes("help") || serveArgv.includes("--help") || serveArgv.includes("-h")) {
    printUsage();
    return;
  }

  const options = await parseServeCommand(serveArgv);
  const pocodexCssPath = fileURLToPath(new URL("./pocodex.css", import.meta.url));
  const importIconSvgPath = fileURLToPath(new URL("./images/import.svg", import.meta.url));
  const bundle = await loadCodexBundle(options.appPath);
  const relay = await AppServerBridge.connect({
    appPath: options.appPath,
    cwd: process.cwd(),
  });

  const sentryOptions: SentryInitOptions = {
    buildFlavor: bundle.buildFlavor,
    appVersion: bundle.version,
    buildNumber: bundle.buildNumber,
    codexAppSessionId: randomUUID(),
  };

  const server = new PocodexServer({
    listenHost: options.listenHost,
    listenPort: options.listenPort,
    token: options.token,
    relay,
    webviewRoot: bundle.webviewRoot,
    readPocodexStylesheet: async () => readFile(pocodexCssPath, "utf8"),
    renderIndexHtml: async () => {
      const indexHtml = await bundle.readIndexHtml();
      return patchIndexHtml(indexHtml, {
        bootstrapScript: renderBootstrapScript({
          sentryOptions,
          stylesheetHref: POCODEX_STYLESHEET_HREF,
          importIconSvg: await readFile(importIconSvgPath, "utf8"),
        }),
        stylesheetHref: POCODEX_STYLESHEET_HREF,
      });
    },
  });

  const stopWatchingStylesheet = options.devMode
    ? watchPocodexStylesheet(pocodexCssPath, () => {
        server.notifyStylesheetReload(String(Date.now()));
      })
    : () => {};

  const shutdown = async (signal: string) => {
    console.log(`\nShutting down Pocodex after ${signal}...`);
    stopWatchingStylesheet();
    await server.close();
    await relay.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await server.listen();
  const listeningAddress = server.getAddress();
  const serveUrls = getServeUrls({
    listenHost: options.listenHost,
    listenPort: listeningAddress.port,
    token: options.token,
  });

  console.log(`Pocodex listening on ${serveUrls.localUrl}`);
  console.log(`Open ${serveUrls.localOpenUrl}`);
  if (serveUrls.networkUrl && serveUrls.networkOpenUrl) {
    console.log(`Local network URL ${serveUrls.networkUrl}`);
    console.log(`Open on your local network ${serveUrls.networkOpenUrl}`);
  } else if (options.listenHost === "0.0.0.0") {
    console.log("Local network URL unavailable; no active LAN IPv4 address was detected.");
  } else if (options.listenHost === "127.0.0.1" || options.listenHost === "localhost") {
    console.log(
      `Local network URL unavailable while listening on ${serveUrls.localUrl} (use --listen 0.0.0.0:${listeningAddress.port} to expose it on your LAN)`,
    );
  }
  console.log(`Using Codex ${bundle.version} from ${bundle.appPath}`);
  console.log(`Using direct app-server bridge from ${bundle.appPath}`);
  if (options.devMode) {
    console.log(`Watching ${pocodexCssPath} for stylesheet changes`);
  }
}

async function parseServeCommand(argv: string[]): Promise<ServeCommandOptions> {
  validateServeArgs(argv);

  const appPath = readFlag(argv, "--app") ?? (await resolveDefaultCodexAppPath());
  const listen = readFlag(argv, "--listen") ?? DEFAULT_LISTEN;
  const token = readFlag(argv, "--token") ?? "";
  const devMode = hasFlag(argv, "--dev");

  const [listenHost, portText] = listen.split(":");
  const listenPort = Number.parseInt(portText ?? "", 10);
  if (!listenHost || !Number.isInteger(listenPort) || listenPort <= 0) {
    throw new Error(`Invalid --listen value: ${listen}`);
  }

  return {
    appPath,
    devMode,
    listenHost,
    listenPort,
    token,
  };
}

function validateServeArgs(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("-")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    if (BOOLEAN_FLAG_NAMES.has(arg)) {
      continue;
    }

    if (FLAG_NAMES_WITH_VALUES.has(arg)) {
      index += 1;
      const value = argv[index];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      continue;
    }

    throw new Error(`Unknown flag: ${arg}`);
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  pocodex [--token <secret>] [--app <path>] [--listen 127.0.0.1:8787] [--dev]");
}

function watchPocodexStylesheet(cssFilePath: string, onChange: () => void): () => void {
  const cssDirectory = dirname(cssFilePath);
  const cssFilename = basename(cssFilePath);
  let debounceTimer: NodeJS.Timeout | undefined;

  const watcher = watch(cssDirectory, (_eventType, changedFilename) => {
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

await main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
