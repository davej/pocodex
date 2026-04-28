# <img src="https://i.imgur.com/ionPEb2.png" alt="Pocodex" width="300">

Pocodex lets you use the Codex desktop app in a regular browser, including on your phone or any other remote device. It's like Claude Code's Remote Control, but for Codex!

It serves the real Codex desktop webview from the installed app bundle, reuses the bundled `codex app-server` as the agentic harness, and adds host-side shims for the desktop functionality the UI expects.

<img src="https://i.imgur.com/mInn7oW.png" alt="Pocodex screenshot" width="200">

## Install

Download the desktop app from [download.pocodex.app](https://download.pocodex.app/).

Or install the CLI:

```bash
pnpm add -g pocodex
```

## Run

```bash
pocodex
```

Pocodex prints a local URL and, when applicable, an "Open" URL. Open the printed URL in your browser.

Pocodex now publishes a web manifest and service worker, so on supported browsers you can install it as a standalone app. If you are using a tokenized URL, open that URL in the browser you plan to install from. Tokens are stored for the current browser session only, so a standalone/PWA launch may need the current printed URL again after the browser session is cleared.

## Requirements

- macOS with a local Codex install, usually `/Applications/Codex.app`, or WSL with the Windows Codex install available under `C:\Program Files\WindowsApps\OpenAI.Codex_...\app`
- Node.js 24 or newer

## Common Usage

Run with the defaults:

```bash
pocodex
```

Expose it on your LAN with a session token:

```bash
pocodex --listen 0.0.0.0:8787 --token "$(openssl rand -hex 16)"
```

When listening on `0.0.0.0`, Pocodex also prints a preferred LAN URL if it can find one.

## CLI

```text
pocodex [--token <secret>] [--app <path>] [--listen 127.0.0.1:8787] [--dev]
```

### Flags

- `--token` optional session secret used to authorize the browser session
- `--app` path to the Codex desktop install root. On macOS this is usually `/Applications/Codex.app`. When running in WSL you can pass either `/mnt/c/Program Files/WindowsApps/OpenAI.Codex_.../app` or the original `C:\Program Files\WindowsApps\OpenAI.Codex_...\app` path.
- `--listen` host and port to bind, for example `127.0.0.1:8787` or `0.0.0.0:8787`
- `--dev` watches `src/pocodex.css` and pushes live CSS reload events to the connected browser

If you expose Pocodex beyond loopback, use only the printed tokenized URL on a trusted network. The token gates `/session`, `/ipc-request`, and host bridge access, and the browser bootstrap stores it in `sessionStorage` for reconnects during the current browser session.

By default, Pocodex uses the same Codex home/state as the desktop app. To keep a separate Pocodex environment, run it with a separate `CODEX_HOME`.

When `--app` is omitted, Pocodex auto-detects `/Applications/Codex.app` on macOS or the newest `OpenAI.Codex_*` Windows Store install when running inside WSL.

## How It Works

### 1. Reuse the real Codex UI

Pocodex reads the shipped `app.asar` from the desktop install and serves those files. The browser is running the real Codex desktop UI, not a reimplementation.

### 2. Patch the webview entrypoint

Before serving `index.html`, Pocodex injects:

- `pocodex.css`
- PWA metadata including the web manifest and mobile install hints
- an inline bootstrap script that installs the browser-side bridge
- a matching CSP hash so the injected script can run under Codex's content security policy

### 3. Reuse Codex's bundled app server

Pocodex starts the app server shipped inside the desktop install:

```text
codex app-server --listen stdio://
```

That process is used as the core agentic harness. Pocodex then bridges the browser session to it.

### 4. Shim the desktop host behavior

Codex's webview expects to live inside Electron with a pile of host APIs behind it. Pocodex provides custom shims for the browser-hosted setup instead:

- terminal sessions are backed by local PTYs via `node-pty`
- git integration is bridged through the desktop git worker extracted from the Codex bundle
- browser `vscode://codex/ipc-request` traffic is translated onto Pocodex's host IPC endpoint
- workspace roots, pinned threads, persisted atoms, and related desktop sidebar state are mirrored on the host side
- unsupported native features are blocked or stubbed where needed

The shim behavior was derived by treating the shipped and minified `Codex.app` code as the implementation oracle.

### 5. Connect the browser over a host HTTP server

Pocodex creates an HTTP server on the host machine and serves the patched webview from there. The browser loads the UI over HTTP, uses `/ipc-request` for host-style requests, and opens a live WebSocket session on `/session` for bridge traffic and worker messages.

A session token gates the browser session. Pocodex supports multiple concurrent browser sessions that share the same backend state.

## Current Limitations

- Native desktop behaviors such as notifications, badge updates, context menus, power-save controls, and window mode controls are blocked or stubbed
- Generic IPC coverage is incomplete; unsupported IPC methods return an error response
- Streaming fetch is not implemented
- Personal ChatGPT cloud fetches under `/wham/*` are proxied through managed local auth, but some workspace, billing, and subscription endpoints still return stubs or placeholder data
- This relies on internal Codex bundle structure and host protocols, so Codex app updates may break assumptions
- Pocodex is suitable for local use and trusted LANs with the printed tokenized URL. Do not expose it directly to the public internet; use Tailscale, WireGuard, Cloudflare Access, or another private access layer for away-from-home use.

## Contributing

Contributor and source-development instructions live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Thanks

Thanks to [Ben Allfree](https://github.com/benallfree) for kindly giving this project the `pocodex` npm package name.
