import type {
  BrowserToServerEnvelope,
  SentryInitOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { serializeInlineScript } from "./inline-script.js";

export interface BootstrapScriptConfig {
  sentryOptions: SentryInitOptions;
  stylesheetHref: string;
  importIconSvg?: string;
}

export function renderBootstrapScript(config: BootstrapScriptConfig): string {
  return serializeInlineScript(bootstrapPocodexInBrowser, config);
}

function bootstrapPocodexInBrowser(config: BootstrapScriptConfig): void {
  type ConnectionStatusOptions = {
    mode?: string;
  };

  type DesktopImportMode = "first-run" | "manual";

  type DesktopImportProject = {
    root: string;
    label: string;
    activeInCodex: boolean;
    alreadyImported: boolean;
    available: boolean;
  };

  type DesktopImportListResult = {
    found: boolean;
    path: string;
    promptSeen: boolean;
    shouldPrompt: boolean;
    projects: DesktopImportProject[];
  };

  type SessionValidationResult =
    | { ok: true }
    | { ok: false; reason: "unauthorized" | "unavailable" };

  type WorkerMessageListener = (message: unknown) => void;

  interface ElectronBridge {
    windowType: "electron";
    sendMessageFromView(message: unknown): Promise<void>;
    getPathForFile(): null;
    sendWorkerMessageFromView(workerName: string, message: unknown): Promise<void>;
    subscribeToWorkerMessages(workerName: string, callback: WorkerMessageListener): () => void;
    showContextMenu(): Promise<void>;
    getFastModeRolloutMetrics(): Promise<Record<string, never>>;
    triggerSentryTestError(): Promise<void>;
    getSentryInitOptions(): SentryInitOptions;
    getAppSessionId(): string;
    getBuildFlavor(): string;
  }

  const POCODEX_STYLESHEET_ID = "pocodex-stylesheet";
  const TOKEN_STORAGE_KEY = "__pocodex_token";
  const RETRY_DELAYS_MS = [1000, 2000, 5000] as const;
  const SESSION_CHECK_PATH = "/session-check";
  const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 640px), (pointer: coarse) and (max-width: 900px)";

  const workerSubscribers = new Map<string, Set<WorkerMessageListener>>();
  const pendingMessages: string[] = [];
  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const importHost = document.createElement("div");

  let socket: WebSocket | null = null;
  let isConnecting = false;
  let reconnectAttempt = 0;
  let isClosing = false;
  let isOpenInAppObserverStarted = false;
  let isImportUiObserverStarted = false;
  let hasConnected = false;
  let hasAttemptedDesktopImportPrompt = false;
  let nextIpcRequestId = 0;

  toastHost.id = "pocodex-toast-host";
  statusHost.id = "pocodex-status-host";
  importHost.id = "pocodex-import-host";
  importHost.hidden = true;
  document.documentElement.dataset.pocodex = "true";

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(importHost);
    startOpenInAppObserver();
    startImportUiObserver();
    installMobileSidebarThreadNavigationClose();
  });

  function runWhenDocumentReady(callback: () => void): void {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  function ensureHostAttached(host: HTMLDivElement): void {
    if (!document.body) {
      runWhenDocumentReady(() => {
        ensureStylesheetLink(config.stylesheetHref);
        ensureHostAttached(host);
      });
      return;
    }
    if (!document.body.contains(host)) {
      document.body.appendChild(host);
    }
  }

  function ensureStylesheetLink(href?: string): HTMLLinkElement | null {
    const head = document.head ?? document.getElementsByTagName("head")[0];
    if (!head) {
      return null;
    }

    const current = document.getElementById(POCODEX_STYLESHEET_ID);
    let link = current instanceof HTMLLinkElement ? current : null;
    if (!link) {
      if (!href) {
        return null;
      }
      link = document.createElement("link");
      link.id = POCODEX_STYLESHEET_ID;
      link.rel = "stylesheet";
      head.appendChild(link);
    }

    if (href) {
      link.href = href;
    }

    return link;
  }

  function reloadStylesheet(href: string): void {
    const currentLink = ensureStylesheetLink();
    if (!currentLink) {
      ensureStylesheetLink(href);
      return;
    }

    const nextLink = document.createElement("link");
    nextLink.id = POCODEX_STYLESHEET_ID;
    nextLink.rel = "stylesheet";
    nextLink.href = href;
    nextLink.addEventListener(
      "load",
      () => {
        currentLink.remove();
      },
      { once: true },
    );
    nextLink.addEventListener(
      "error",
      () => {
        nextLink.remove();
        showNotice("Failed to reload Pocodex CSS.");
      },
      { once: true },
    );
    currentLink.after(nextLink);
  }

  function showNotice(message: string): void {
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.dataset.pocodexToast = "true";
    ensureHostAttached(toastHost);
    toastHost.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 5000);
  }

  function setConnectionStatus(message: string, options: ConnectionStatusOptions = {}): void {
    ensureHostAttached(statusHost);
    statusHost.replaceChildren();
    statusHost.dataset.mode = options.mode ?? "blocking";
    statusHost.hidden = false;

    const card = document.createElement("div");
    card.dataset.pocodexStatusCard = "true";

    const title = document.createElement("strong");
    title.textContent = "Pocodex";

    const body = document.createElement("p");
    body.textContent = message;

    card.append(title, body);
    statusHost.appendChild(card);
  }

  function clearConnectionStatus(): void {
    statusHost.hidden = true;
    delete statusHost.dataset.mode;
    statusHost.replaceChildren();
  }

  function installMobileSidebarThreadNavigationClose(): void {
    document.addEventListener("click", handleMobileSidebarThreadClick, true);
    document.addEventListener("click", handleMobileContentPaneClick, true);
  }

  function handleMobileSidebarThreadClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const navigation = target.closest('nav[role="navigation"]');
    if (!navigation) {
      return;
    }

    const nearestInteractive = target.closest(
      'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
    );
    if (!nearestInteractive || !navigation.contains(nearestInteractive)) {
      return;
    }

    if (
      isMobileSidebarThreadRow(nearestInteractive) ||
      isMobileSidebarNewThreadTrigger(nearestInteractive)
    ) {
      scheduleMobileSidebarClose();
    }
  }

  function isMobileSidebarThreadRow(element: Element): boolean {
    if (
      element.tagName === "BUTTON" ||
      element.getAttribute("role") !== "button" ||
      !element.closest('nav[role="navigation"]')
    ) {
      return false;
    }

    if (element.querySelector("[data-thread-title]")) {
      return true;
    }

    if (!element.closest('[role="listitem"]')) {
      return false;
    }

    const buttons = element.querySelectorAll("button");
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index);
      const ariaLabel = button?.getAttribute("aria-label");
      if (ariaLabel === "Archive thread" || ariaLabel === "Unarchive thread") {
        return true;
      }
    }

    return false;
  }

  function isMobileSidebarNewThreadTrigger(element: Element): boolean {
    if (
      !element.closest('nav[role="navigation"]') ||
      (element.tagName !== "BUTTON" && element.tagName !== "A")
    ) {
      return false;
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (ariaLabel === "new thread" || ariaLabel.startsWith("start new thread in ")) {
      return true;
    }

    const text = element.textContent?.trim().toLowerCase() ?? "";
    return text === "new thread";
  }

  function handleMobileContentPaneClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest('nav[role="navigation"]') || !target.closest(".main-surface")) {
      return;
    }

    if (!isMobileSidebarOpen()) {
      return;
    }

    scheduleMobileSidebarClose();
  }

  function scheduleMobileSidebarClose(): void {
    window.setTimeout(() => {
      if (isMobileSidebarViewport() && isMobileSidebarOpen()) {
        dispatchHostMessage({ type: "toggle-sidebar" });
      }
    }, 0);
  }

  function isMobileSidebarOpen(): boolean {
    const contentPane = document.querySelector(".main-surface");
    if (!(contentPane instanceof Element)) {
      return false;
    }

    const style = (
      contentPane as Element & {
        style?: { width?: string; transform?: string };
      }
    ).style;
    const width = typeof style?.width === "string" ? style.width.trim() : "";
    if (width !== "" && width !== "100%") {
      return true;
    }

    const transform = typeof style?.transform === "string" ? style.transform.trim() : "";
    if (transform !== "" && transform !== "translateX(0)" && transform !== "translateX(0px)") {
      return true;
    }

    return isMobileSidebarOpenByGeometry(contentPane);
  }

  function isMobileSidebarOpenByGeometry(contentPane: Element): boolean {
    if (typeof contentPane.getBoundingClientRect !== "function") {
      return false;
    }

    const viewportWidth = typeof window.innerWidth === "number" ? window.innerWidth : 0;
    const rect = contentPane.getBoundingClientRect();
    if (rect.left > 0.5) {
      return true;
    }

    if (viewportWidth > 0 && rect.width > 0 && rect.width < viewportWidth - 0.5) {
      return true;
    }

    const navigation = document.querySelector('nav[role="navigation"]');
    if (
      !(navigation instanceof Element) ||
      typeof navigation.getBoundingClientRect !== "function"
    ) {
      return false;
    }

    const navigationRect = navigation.getBoundingClientRect();
    return navigationRect.left >= -0.5 && navigationRect.right > 0.5 && navigationRect.width > 0.5;
  }

  function isMobileSidebarViewport(): boolean {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
    }
    return window.innerWidth <= 640;
  }

  function isPrimaryUnmodifiedClick(event: MouseEvent): boolean {
    return (
      !event.defaultPrevented &&
      (event.button ?? 0) === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    );
  }

  function isOpenInAppButtonGroup(group: HTMLDivElement): boolean {
    const buttons = group.querySelectorAll(":scope > button");
    if (buttons.length !== 2) {
      return false;
    }

    const primary = buttons.item(0);
    const secondary = buttons.item(1);
    if (!primary || !secondary) {
      return false;
    }

    return Boolean(
      primary.querySelector("img.icon-sm, img") &&
      secondary.getAttribute("aria-label") === "Secondary action" &&
      secondary.getAttribute("aria-haspopup") === "menu",
    );
  }

  function tagOpenInAppButtons(root: Document | Element = document): void {
    root.querySelectorAll("div.inline-flex").forEach((group) => {
      if (!(group instanceof HTMLDivElement)) {
        return;
      }
      if (isOpenInAppButtonGroup(group)) {
        group.dataset.pocodexOpenInApp = "true";
        return;
      }
      delete group.dataset.pocodexOpenInApp;
    });
  }

  function startOpenInAppObserver(): void {
    if (isOpenInAppObserverStarted || !document.body) {
      return;
    }

    isOpenInAppObserverStarted = true;
    tagOpenInAppButtons(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }
          tagOpenInAppButtons(node);
          if (node.parentElement) {
            tagOpenInAppButtons(node.parentElement);
          }
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function startImportUiObserver(): void {
    if (isImportUiObserverStarted || !document.body) {
      return;
    }

    isImportUiObserverStarted = true;
    refreshImportUi(document);

    const observer = new MutationObserver(() => {
      refreshImportUi(document);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function refreshImportUi(root: Document | Element = document): void {
    root.querySelectorAll('[role="menu"]').forEach((candidate) => {
      if (!(candidate instanceof Element)) {
        return;
      }
      maybeInjectSettingsMenuImportItem(candidate);
    });
  }

  function maybeInjectSettingsMenuImportItem(menu: Element): void {
    if (!looksLikeSettingsMenu(menu)) {
      return;
    }

    if (menu.querySelector('[data-pocodex-import-menu-item="true"]')) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.dataset.pocodexImportMenuItem = "true";
    const label = document.createElement("span");
    label.dataset.pocodexImportMenuLabel = "true";
    label.textContent = "Import from Codex.app";
    button.append(createImportMenuItemIcon(), label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openDesktopImportDialog("manual");
    });

    const separator = document.createElement("div");
    separator.role = "separator";
    separator.dataset.pocodexImportMenuSeparator = "true";

    menu.append(separator, button);
  }

  function createImportMenuItemIcon(): HTMLSpanElement {
    const icon = document.createElement("span");
    icon.dataset.pocodexImportMenuIcon = "true";
    if (config.importIconSvg) {
      icon.innerHTML = config.importIconSvg.trim();
    }
    return icon;
  }

  function looksLikeSettingsMenu(menu: Element): boolean {
    let hasSettingsItem = false;
    let hasLogOutItem = false;

    menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
      if (!(item instanceof Element)) {
        return;
      }

      const text = item.textContent?.trim().toLowerCase() ?? "";
      if (text === "settings") {
        hasSettingsItem = true;
      }
      if (text === "log out") {
        hasLogOutItem = true;
      }
    });

    return hasSettingsItem && hasLogOutItem;
  }

  async function maybePromptForDesktopImport(): Promise<void> {
    if (hasAttemptedDesktopImportPrompt) {
      return;
    }

    hasAttemptedDesktopImportPrompt = true;
    await openDesktopImportDialog("first-run");
  }

  async function openDesktopImportDialog(mode: DesktopImportMode): Promise<void> {
    const result = await listDesktopImportProjects();
    if (!result) {
      return;
    }

    const importableProjects = result.projects.filter(
      (project) => project.available && !project.alreadyImported,
    );
    if (mode === "first-run" && !result.shouldPrompt) {
      return;
    }

    if (!result.found) {
      if (mode === "manual") {
        showNotice("Codex.app project state was not found.");
      }
      return;
    }

    if (importableProjects.length === 0) {
      if (mode === "manual") {
        showNotice("No additional Codex.app projects are available to import.");
      }
      return;
    }

    renderDesktopImportDialog(result, mode);
  }

  function renderDesktopImportDialog(
    result: DesktopImportListResult,
    mode: DesktopImportMode,
  ): void {
    ensureHostAttached(importHost);
    importHost.hidden = false;
    importHost.replaceChildren();

    const importableRoots = new Set(
      result.projects
        .filter((project) => project.available && !project.alreadyImported)
        .map((project) => project.root),
    );

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexImportBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexImportDialog = "true";

    const header = document.createElement("div");
    header.dataset.pocodexImportHeader = "true";

    const title = document.createElement("h2");
    title.textContent = "Import projects from Codex.app";

    const subtitle = document.createElement("p");
    subtitle.textContent =
      mode === "first-run"
        ? "Choose which saved Codex.app projects you want to add to Pocodex."
        : "Select any additional Codex.app projects you want to bring into Pocodex.";

    header.append(title, subtitle);

    const list = document.createElement("div");
    list.dataset.pocodexImportList = "true";

    const selectedRoots = new Set<string>();
    const sortedProjects = [...result.projects].sort((left, right) => {
      if (left.activeInCodex !== right.activeInCodex) {
        return left.activeInCodex ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    for (const project of sortedProjects) {
      const row = document.createElement("label");
      row.dataset.pocodexImportRow = "true";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = project.root;
      checkbox.disabled = !importableRoots.has(project.root);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedRoots.add(project.root);
        } else {
          selectedRoots.delete(project.root);
        }
        importButton.disabled = selectedRoots.size === 0;
      });

      const details = document.createElement("div");
      details.dataset.pocodexImportDetails = "true";

      const label = document.createElement("strong");
      label.textContent = project.label;

      const root = document.createElement("code");
      root.textContent = formatDesktopImportPath(project.root);

      details.append(label, root);

      const badges = document.createElement("div");
      badges.dataset.pocodexImportBadges = "true";
      if (project.activeInCodex) {
        badges.appendChild(createDesktopImportBadge("Active in Codex.app"));
      }
      if (project.alreadyImported) {
        badges.appendChild(createDesktopImportBadge("Already in Pocodex"));
      } else if (!project.available) {
        badges.appendChild(createDesktopImportBadge("Missing on disk"));
      }

      row.append(checkbox, details);
      if (badges.childNodes.length > 0) {
        row.appendChild(badges);
      }
      list.appendChild(row);
    }

    const actions = document.createElement("div");
    actions.dataset.pocodexImportActions = "true";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = mode === "first-run" ? "Skip for now" : "Cancel";
    cancelButton.addEventListener("click", () => {
      closeDesktopImportDialog(mode === "first-run");
    });

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.dataset.variant = "primary";
    importButton.disabled = true;
    importButton.textContent = "Import selected";
    importButton.addEventListener("click", async () => {
      const roots = [...selectedRoots];
      if (roots.length === 0) {
        return;
      }

      importButton.disabled = true;
      cancelButton.disabled = true;
      importButton.textContent = "Importing...";

      try {
        const result = await callPocodexIpc("desktop-workspace-import/apply", {
          roots,
        });
        const importedRoots = getImportedRoots(result);
        closeDesktopImportDialog(false);
        if (importedRoots.length > 0) {
          showNotice(
            importedRoots.length === 1
              ? "Imported 1 project from Codex.app."
              : `Imported ${importedRoots.length} projects from Codex.app.`,
          );
        } else {
          showNotice("No new Codex.app projects were imported.");
        }
      } catch (error) {
        importButton.textContent = "Import selected";
        cancelButton.disabled = false;
        importButton.disabled = selectedRoots.size === 0;
        showNotice(
          error instanceof Error ? error.message : "Failed to import projects from Codex.app.",
        );
      }
    });

    actions.append(cancelButton, importButton);
    dialog.append(header, list, actions);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      closeDesktopImportDialog(mode === "first-run");
    });

    importHost.appendChild(backdrop);
  }

  function formatDesktopImportPath(path: string): string {
    const trimmedPath = path.trim();
    if (trimmedPath.length === 0) {
      return path;
    }

    return trimmedPath.replace(/^\/(?:users|home)\/[^/]+(?=\/|$)/i, "~");
  }

  function createDesktopImportBadge(text: string): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.dataset.pocodexImportBadge = "true";
    badge.textContent = text;
    return badge;
  }

  function closeDesktopImportDialog(markPromptSeen: boolean): void {
    importHost.hidden = true;
    importHost.replaceChildren();
    if (markPromptSeen) {
      void dismissDesktopImportPrompt();
    }
  }

  async function dismissDesktopImportPrompt(): Promise<void> {
    try {
      await callPocodexIpc("desktop-workspace-import/dismiss");
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "Failed to dismiss the Codex.app import prompt.",
      );
    }
  }

  async function listDesktopImportProjects(): Promise<DesktopImportListResult | null> {
    try {
      const result = await callPocodexIpc("desktop-workspace-import/list");
      return isDesktopImportListResult(result) ? result : null;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Failed to load Codex.app projects.");
      return null;
    }
  }

  async function callPocodexIpc(method: string, params?: unknown): Promise<unknown> {
    const response = await nativeFetch("/ipc-request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({
        requestId: `pocodex-ipc-${++nextIpcRequestId}`,
        method,
        params,
      }),
    });
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || payload.resultType !== "success") {
      const error =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `IPC request failed (${response.status}).`;
      throw new Error(error);
    }

    return payload.result;
  }

  function getImportedRoots(result: unknown): string[] {
    if (!isRecord(result) || !Array.isArray(result.importedRoots)) {
      return [];
    }

    return result.importedRoots.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  function isDesktopImportListResult(value: unknown): value is DesktopImportListResult {
    return (
      isRecord(value) &&
      typeof value.found === "boolean" &&
      typeof value.path === "string" &&
      typeof value.promptSeen === "boolean" &&
      typeof value.shouldPrompt === "boolean" &&
      Array.isArray(value.projects)
    );
  }

  function dispatchHostMessage(message: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  function rewriteBridgeMessageForViewport(message: unknown): unknown {
    if (!isMobileSidebarViewport() || !isRecord(message) || typeof message.type !== "string") {
      return message;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? { ...message.state } : {};
      state["enter-behavior"] = "newline";
      return {
        ...message,
        state,
      };
    }

    if (message.type === "persisted-atom-updated" && message.key === "enter-behavior") {
      return {
        ...message,
        value: "newline",
        deleted: false,
      };
    }

    return message;
  }

  function handlePocodexBridgeMessage(message: unknown): boolean {
    if (!isRecord(message) || typeof message.type !== "string") {
      return false;
    }

    if (message.type === "pocodex-open-desktop-import-dialog") {
      const mode = message.mode === "first-run" ? "first-run" : "manual";
      void openDesktopImportDialog(mode);
      return true;
    }

    return false;
  }

  function getStoredToken(): string {
    const url = new URL(window.location.href);
    const tokenFromQuery = url.searchParams.get("token");
    if (tokenFromQuery) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, tokenFromQuery);
      return tokenFromQuery;
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  }

  function getSocketUrl(token: string): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/session`);
    if (token) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  }

  function getSessionCheckUrl(token: string): string {
    const url = new URL(SESSION_CHECK_PATH, window.location.href);
    if (token) {
      url.searchParams.set("token", token);
    }
    return `${url.pathname}${url.search}`;
  }

  async function validateSessionToken(token: string): Promise<SessionValidationResult> {
    try {
      const response = await window.fetch(getSessionCheckUrl(token), {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (response.ok) {
        return { ok: true };
      }
      if (response.status === 401) {
        return { ok: false, reason: "unauthorized" };
      }
      return { ok: false, reason: "unavailable" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  function scheduleReconnect(message: string): void {
    const delay = RETRY_DELAYS_MS[Math.min(reconnectAttempt, RETRY_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    setConnectionStatus(message);
    window.setTimeout(() => {
      void connectSocket();
    }, delay);
  }

  function flushPendingMessages(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      if (message === undefined) {
        return;
      }
      socket.send(message);
    }
  }

  function sendEnvelope(envelope: BrowserToServerEnvelope): void {
    const serialized = JSON.stringify(envelope);
    if (!socket) {
      pendingMessages.push(serialized);
      void connectSocket();
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      pendingMessages.push(serialized);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      pendingMessages.push(serialized);
      void connectSocket();
      return;
    }
    socket.send(serialized);
  }

  function publishFocusState(): void {
    sendEnvelope({
      type: "focus_state",
      isFocused: document.visibilityState === "visible" && document.hasFocus(),
    });
  }

  async function connectSocket(): Promise<void> {
    const isSocketActive =
      socket !== null &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    if (isClosing || isConnecting || isSocketActive) {
      return;
    }

    const token = getStoredToken();
    isConnecting = true;
    setConnectionStatus(hasConnected ? "Reconnecting to Pocodex..." : "Connecting to Pocodex...");

    const validation = await validateSessionToken(token);
    if (!validation.ok) {
      isConnecting = false;
      if (validation.reason === "unauthorized") {
        setConnectionStatus(
          token
            ? "Pocodex rejected this token. Open the exact URL printed by the CLI for the current run."
            : "Pocodex requires a token. Open the exact URL printed by the CLI for the current run.",
        );
        return;
      }
      scheduleReconnect("Pocodex is unavailable. Retrying...");
      return;
    }

    socket = new WebSocket(getSocketUrl(token));
    socket.addEventListener("open", () => {
      isConnecting = false;
      reconnectAttempt = 0;
      const shouldReload = hasConnected;
      hasConnected = true;
      clearConnectionStatus();
      flushPendingMessages();
      publishFocusState();
      for (const workerName of workerSubscribers.keys()) {
        sendEnvelope({ type: "worker_subscribe", workerName });
      }
      if (!shouldReload) {
        window.setTimeout(() => {
          void maybePromptForDesktopImport();
        }, 250);
      }
      if (shouldReload) {
        window.location.reload();
      }
    });

    socket.addEventListener("error", () => {
      if (!hasConnected) {
        setConnectionStatus(
          "Pocodex could not open its live session. Check the CLI output and the page token.",
        );
      }
    });

    socket.addEventListener("message", (event) => {
      const envelope = parseServerEnvelope(event.data);
      if (!envelope) {
        showNotice("Pocodex received invalid server data.");
        return;
      }

      switch (envelope.type) {
        case "bridge_message":
          {
            const bridgeMessage = rewriteBridgeMessageForViewport(envelope.message);
            if (handlePocodexBridgeMessage(bridgeMessage)) {
              break;
            }
            dispatchHostMessage(bridgeMessage);
          }
          break;
        case "worker_message": {
          const listeners = workerSubscribers.get(envelope.workerName);
          listeners?.forEach((listener) => listener(envelope.message));
          break;
        }
        case "client_notice":
          showNotice(envelope.message);
          break;
        case "css_reload":
          reloadStylesheet(envelope.href);
          break;
        case "session_revoked":
          showNotice(envelope.reason || "This Pocodex session is no longer available.");
          setConnectionStatus(envelope.reason || "This Pocodex session is no longer available.");
          isClosing = true;
          socket?.close(4001, "revoked");
          break;
        case "error":
          showNotice(envelope.message);
          break;
      }
    });

    socket.addEventListener("close", () => {
      const shouldReconnect = !isClosing;
      socket = null;
      isConnecting = false;
      if (!shouldReconnect) {
        return;
      }
      showNotice("Pocodex lost the host connection. Retrying...");
      scheduleReconnect("Pocodex lost the host connection. Retrying...");
    });
  }

  function parseServerEnvelope(data: unknown): ServerToBrowserEnvelope | null {
    try {
      const parsed = JSON.parse(String(data)) as unknown;
      return isServerToBrowserEnvelope(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function isServerToBrowserEnvelope(value: unknown): value is ServerToBrowserEnvelope {
    if (!isRecord(value) || typeof value.type !== "string") {
      return false;
    }

    switch (value.type) {
      case "bridge_message":
        return "message" in value;
      case "worker_message":
        return typeof value.workerName === "string" && "message" in value;
      case "client_notice":
        return typeof value.message === "string";
      case "css_reload":
        return typeof value.href === "string";
      case "session_revoked":
        return typeof value.reason === "string";
      case "error":
        return typeof value.message === "string";
      default:
        return false;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function addWorkerSubscriber(workerName: string, callback: WorkerMessageListener): () => void {
    let listeners = workerSubscribers.get(workerName);
    if (!listeners) {
      listeners = new Set<WorkerMessageListener>();
      workerSubscribers.set(workerName, listeners);
      sendEnvelope({ type: "worker_subscribe", workerName });
    }

    listeners.add(callback);
    return () => {
      const currentListeners = workerSubscribers.get(workerName);
      if (!currentListeners) {
        return;
      }
      currentListeners.delete(callback);
      if (currentListeners.size === 0) {
        workerSubscribers.delete(workerName);
        sendEnvelope({ type: "worker_unsubscribe", workerName });
      }
    };
  }

  const electronBridge: ElectronBridge = {
    windowType: "electron",
    sendMessageFromView: async (message) => {
      if (isRecord(message) && message.type === "electron-window-focus-request") {
        dispatchHostMessage({
          type: "electron-window-focus-changed",
          isFocused: document.visibilityState === "visible" && document.hasFocus(),
        });
        return;
      }
      if (isRecord(message) && message.type === "open-in-browser") {
        const rawUrl = typeof message.url === "string" ? message.url.trim() : "";
        if (rawUrl.length === 0) {
          showNotice("Open in browser failed: missing URL.");
          return;
        }
        try {
          const url = new URL(rawUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error(`Unsupported protocol: ${url.protocol}`);
          }
          window.open(url.toString(), "_blank", "noopener,noreferrer");
        } catch {
          showNotice("Open in browser failed: invalid URL.");
        }
        return;
      }
      sendEnvelope({ type: "bridge_message", message });
    },
    getPathForFile: () => null,
    sendWorkerMessageFromView: async (workerName, message) => {
      sendEnvelope({ type: "worker_message", workerName, message });
    },
    subscribeToWorkerMessages: (workerName, callback) => addWorkerSubscriber(workerName, callback),
    showContextMenu: async () => {
      showNotice("Context menus are not available in Pocodex.");
    },
    getFastModeRolloutMetrics: async () => ({}),
    triggerSentryTestError: async () => {},
    getSentryInitOptions: () => config.sentryOptions,
    getAppSessionId: () => config.sentryOptions.codexAppSessionId,
    getBuildFlavor: () => config.sentryOptions.buildFlavor,
  };

  const nativeFetch: typeof window.fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.startsWith("sentry-ipc://")) {
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === "vscode://codex/ipc-request") {
      const method =
        init?.method ??
        (input instanceof Request ? (input as Request & { method?: string }).method : undefined) ??
        "POST";
      return nativeFetch("/ipc-request", {
        method,
        body: init?.body,
        headers: init?.headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    }
    return nativeFetch(input, init);
  };

  Object.defineProperty(window, "codexWindowType", {
    value: "electron",
    configurable: false,
    enumerable: true,
    writable: false,
  });
  Object.defineProperty(window, "electronBridge", {
    value: electronBridge,
    configurable: false,
    enumerable: true,
    writable: false,
  });

  window.addEventListener("focus", publishFocusState);
  window.addEventListener("blur", publishFocusState);
  document.addEventListener("visibilitychange", publishFocusState);
  window.addEventListener(
    "beforeunload",
    () => {
      isClosing = true;
      if (socket) {
        socket.close(1000, "unload");
      }
    },
    { once: true },
  );

  void connectSocket();
}
