# Contributing

## Development Setup

Requirements:

- macOS with a local Codex install, usually `/Applications/Codex.app`, or WSL with the Windows Codex install available under `C:\Program Files\WindowsApps\OpenAI.Codex_...\app`
- Node.js 24 or newer
- pnpm

Install dependencies:

```bash
pnpm install
```

Run Pocodex directly from source with live CSS reloads and without interrupting the active Codex session:

```bash
pnpm run dev
```

If you want automatic restart on TypeScript changes, use the explicit watcher:

```bash
pnpm run dev:watch
```

Or build first and run the compiled CLI:

```bash
pnpm run build
node dist/cli.js
```

If you are running from WSL, `pnpm run dev -- --app 'C:\Program Files\WindowsApps\OpenAI.Codex_...\app'` works, and so does the equivalent `/mnt/c/...` path.

## Useful Commands

```bash
pnpm run check:commit
pnpm run build
pnpm run check
pnpm run typecheck
pnpm run test
```

## Commit And Release Policy

- Commits must use Conventional Commits. The local `commit-msg` hook enforces this with `commitlint`.
- The local `pre-commit` hook runs `pnpm run check:commit` for formatting, lint, and type checks without running tests.
- Run `pnpm run check` when you want the full local validation pass, including tests.
- Releases are managed by `release-please` from commits merged into `main`, so `feat`, `fix`, and `!`/`BREAKING CHANGE:` markers drive versioning and changelog entries.

For runtime logging:

```bash
POCODEX_DEBUG=1 pnpm run dev
```

For UI work, start with:

```bash
pnpm run dev
```

Then edit `src/pocodex.css`. Pocodex watches that file and notifies the active browser session to swap in the new stylesheet without restarting the server.

## Architecture

### 1. Load the shipped Codex bundle

Pocodex resolves either the macOS `Codex.app` bundle layout or the Windows Store `.../app/resources` layout, extracts the `/webview` files from `app.asar` into `~/.cache/pocodex/<version>`, and serves those real web assets instead of a locally rebuilt frontend.

### 2. Patch the webview entry HTML

Before serving `index.html`, Pocodex injects:

- a dedicated stylesheet link for `pocodex.css`
- an inline bootstrap script that installs the browser-side bridge
- a matching CSP hash so the injected script can run under Codex's content security policy

### 3. Spawn the bundled `codex app-server`

Pocodex starts the CLI shipped inside the desktop install with:

```text
codex app-server --listen stdio://
```

It then initializes a JSON-RPC/MCP session over stdio and uses that process as the host runtime behind the browser session.

On WSL, the bundled Linux `resources/codex` binary is copied into Pocodex's cache first so it can be executed outside the read-only WindowsApps mount.

### 4. Serve a browser-facing bridge

The local HTTP server exposes:

- `/` and `/index.html` for the patched Codex webview
- `/pocodex.css` for Pocodex-specific styling
- `/session-check` for optional token validation before WebSocket attach
- `/session` as the browser's live WebSocket bridge
- `/ipc-request` for browser requests that need to be mapped onto host-style IPC
- `/healthz` for a simple health check

The WebSocket channel carries bridge messages, worker messages, focus state, CSS reload notifications, and session revocation notices.

### 5. Emulate the Electron host APIs in the browser

The injected bootstrap script installs a browser-side bridge that looks enough like the desktop environment for the Codex webview to run. It:

- validates the configured token, if any, and opens the `/session` WebSocket
- forwards host bridge messages between the page and Pocodex
- translates browser fetches for `vscode://codex/ipc-request` into `/ipc-request`
- reconnects on transient failure
- surfaces connection state in a small Pocodex status overlay
- supports CSS hot reload in `--dev` mode
- supports the integrated terminal via a local PTY bridge on the Pocodex host
- supports git integration via a local git worker
