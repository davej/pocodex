#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_POCODEX_APP_PATH, createPocodexRuntime } from "./index.js";
import type { ServeCommandOptions } from "./lib/protocol.js";

const DEFAULT_LISTEN = "127.0.0.1:8787";
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

  const options = parseServeCommand(serveArgv);
  const pocodexCssPath = fileURLToPath(new URL("./pocodex.css", import.meta.url));
  const runtime = createPocodexRuntime({
    ...options,
    cwd: process.cwd(),
  });
  runtime.on("error", (error) => {
    console.error(error.message);
  });

  const shutdown = async (signal: string) => {
    console.log(`\nShutting down Pocodex after ${signal}...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const snapshot = await runtime.start();

  if (!snapshot.localUrl || !snapshot.localOpenUrl) {
    throw new Error("Pocodex started without a local URL.");
  }

  console.log(`Pocodex listening on ${snapshot.localUrl}`);
  console.log(`Open ${snapshot.localOpenUrl}`);
  if (snapshot.networkUrl && snapshot.networkOpenUrl) {
    console.log(`Local network URL ${snapshot.networkUrl}`);
    console.log(`Open on your local network ${snapshot.networkOpenUrl}`);
  } else if (options.listenHost === "0.0.0.0") {
    console.log("Local network URL unavailable; no active LAN IPv4 address was detected.");
  } else if (options.listenHost === "127.0.0.1" || options.listenHost === "localhost") {
    console.log(
      `Local network URL unavailable while listening on ${snapshot.localUrl} (use --listen 0.0.0.0:${snapshot.listenPort} to expose it on your LAN)`,
    );
  }
  console.log(`Using Codex ${snapshot.codexVersion ?? "unknown"} from ${snapshot.appPath}`);
  console.log(`Using direct app-server bridge from ${options.appPath}`);
  if (options.devMode) {
    console.log(`Watching ${pocodexCssPath} for stylesheet changes`);
  }
}

function parseServeCommand(argv: string[]): ServeCommandOptions {
  validateServeArgs(argv);

  const appPath = readFlag(argv, "--app") ?? DEFAULT_POCODEX_APP_PATH;
  const listen = readFlag(argv, "--listen") ?? DEFAULT_LISTEN;
  const token = readFlag(argv, "--token") ?? "";
  const devMode = hasFlag(argv, "--dev");

  const [listenHost, portText] = listen.split(":");
  const listenPort = Number.parseInt(portText ?? "", 10);
  if (!listenHost || !Number.isInteger(listenPort) || listenPort < 0) {
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
  console.error(
    "  pocodex [--token <secret>] [--app /Applications/Codex.app] [--listen 127.0.0.1:8787] [--dev]",
  );
}

await main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
