import type {
  BrowserToServerEnvelope,
  SentryInitOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { serializeInlineScript } from "./inline-script.js";

export interface BootstrapScriptConfig {
  devMode?: boolean;
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

  type ConnectionPhase = "connected" | "degraded" | "reconnecting" | "reload-required";

  type SidebarMode = "expanded" | "collapsed";
  type WorkspaceRootPickerContext = "manual" | "onboarding";

  type WorkspaceRootPickerEntry = {
    name: string;
    path: string;
  };

  type WorkspaceRootPickerListResult = {
    currentPath: string;
    parentPath: string | null;
    homePath: string;
    entries: WorkspaceRootPickerEntry[];
  };

  type WorkspaceRootPickerState = {
    context: WorkspaceRootPickerContext;
    currentPath: string;
    parentPath: string | null;
    entries: WorkspaceRootPickerEntry[];
    pathInputValue: string;
    errorMessage: string | null;
    hasOpenedPath: boolean;
    isLoading: boolean;
    isCreatingDirectory: boolean;
    isCancelling: boolean;
    isConfirming: boolean;
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
  const POCODEX_SERVICE_WORKER_PATH = "/service-worker.js";
  const TOKEN_STORAGE_KEY = "__pocodex_token";
  const THREAD_QUERY_KEY = "thread";
  const LEGACY_INITIAL_ROUTE_QUERY_KEY = "initialRoute";
  const INDEX_HTML_PATHNAME = "/index.html";
  const LOCAL_HOST_ID = "local";
  const LOCAL_THREAD_ROUTE_PREFIX = "/local/";
  const RETRY_DELAYS_MS = [1000, 2000, 5000, 8000, 12000] as const;
  const SESSION_CHECK_PATH = "/session-check";
  const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 640px), (pointer: coarse) and (max-width: 900px)";
  const SIDEBAR_MODE_PERSISTED_ATOM_KEY = "pocodex-sidebar-mode";
  const SIDEBAR_INTERACTION_ARM_MS = 500;
  const SIDEBAR_MODE_TOGGLE_SETTLE_MS = 350;
  const HEARTBEAT_STALE_AFTER_MS = 45_000;
  const HEARTBEAT_MONITOR_INTERVAL_MS = 5_000;
  const WAKE_GRACE_PERIOD_MS = 10_000;
  const RELOAD_REQUIRED_FAILURE_COUNT = 6;

  const workerSubscribers = new Map<string, Set<WorkerMessageListener>>();
  const pendingMessages: string[] = [];
  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const workspaceRootPickerHost = document.createElement("div");

  let socket: WebSocket | null = null;
  let isConnecting = false;
  let reconnectAttempt = 0;
  let isClosing = false;
  let isOpenInAppObserverStarted = false;
  let hasConnected = false;
  let nextIpcRequestId = 0;
  let connectionPhase: ConnectionPhase = "reconnecting";
  let reconnectTimer: number | null = null;
  let heartbeatMonitorTimer: number | null = null;
  let lastServerHeartbeatAt = 0;
  let wakeGraceDeadline = 0;
  let hasScheduledInitialThreadRestore = false;
  let sidebarModeFromHost: SidebarMode | null = null;
  let hasReceivedSidebarModeSync = false;
  let hasRestoredSidebarMode = false;
  let sidebarModeObserver: MutationObserver | null = null;
  let sidebarModeReconcileTimer: number | null = null;
  let sidebarModePendingRetries = 0;
  let isSidebarModeInteractionArmed = false;
  let sidebarModeInteractionTimer: number | null = null;
  let pendingSidebarModeTarget: SidebarMode | null = null;
  let pendingSidebarModeTargetUntil = 0;
  let workspaceRootPickerState: WorkspaceRootPickerState | null = null;

  toastHost.id = "pocodex-toast-host";
  statusHost.id = "pocodex-status-host";
  workspaceRootPickerHost.id = "pocodex-workspace-root-picker-host";
  workspaceRootPickerHost.hidden = true;
  document.documentElement.dataset.pocodex = "true";
  normalizeBrowserUrlForRefresh();

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(workspaceRootPickerHost);
    startOpenInAppObserver();
    installNewThreadNavigationSync();
    installLocalAttachmentPickerInterception();
    installMobileSidebarThreadNavigationClose();
    installSidebarModePersistence();
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

  function getStorage(storageName: "localStorage" | "sessionStorage"): {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem?: (key: string) => void;
  } | null {
    try {
      const windowRecord = window as unknown as Record<string, unknown>;
      const globalRecord = globalThis as Record<string, unknown>;
      const candidate = windowRecord[storageName] ?? globalRecord[storageName];
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "getItem" in candidate &&
        typeof candidate.getItem === "function" &&
        "setItem" in candidate &&
        typeof candidate.setItem === "function"
      ) {
        return candidate as {
          getItem: (key: string) => string | null;
          setItem: (key: string, value: string) => void;
          removeItem?: (key: string) => void;
        };
      }
    } catch {
      // Continue without persistent storage support.
    }

    return null;
  }

  function readStoredTokenValue(storageName: "localStorage" | "sessionStorage"): string {
    const storedValue = getStorage(storageName)?.getItem(TOKEN_STORAGE_KEY)?.trim();
    return storedValue ? storedValue : "";
  }

  function persistSessionToken(token: string): void {
    for (const storageName of ["sessionStorage", "localStorage"] as const) {
      const storage = getStorage(storageName);
      if (!storage) {
        continue;
      }

      if (token) {
        storage.setItem(TOKEN_STORAGE_KEY, token);
        continue;
      }

      if (typeof storage.removeItem === "function") {
        storage.removeItem(TOKEN_STORAGE_KEY);
      } else {
        storage.setItem(TOKEN_STORAGE_KEY, "");
      }
    }
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

  function setConnectionPhase(
    phase: ConnectionPhase,
    message?: string,
    options: ConnectionStatusOptions = {},
  ): void {
    connectionPhase = phase;
    if (!message) {
      clearConnectionStatus();
      return;
    }

    setConnectionStatus(message, options);
  }

  function installMobileSidebarThreadNavigationClose(): void {
    document.addEventListener("click", handleMobileSidebarThreadClick, true);
    document.addEventListener("click", handleMobileContentPaneClick, true);
  }

  function installSidebarModePersistence(): void {
    document.addEventListener("click", handleSidebarClick, true);
    document.addEventListener("keydown", handleSidebarKeydown, true);
    window.addEventListener("resize", handleSidebarLayoutChange);
    startSidebarModeObserver();
    scheduleSidebarModeReconcile(20);
  }

  function installNewThreadNavigationSync(): void {
    document.addEventListener("click", handleNewThreadTriggerClick, true);
  }

  function installLocalAttachmentPickerInterception(): void {
    document.addEventListener("click", handleLocalAttachmentPickerClick, true);
  }

  function handleSidebarClick(event: MouseEvent): void {
    if (!isPrimaryUnmodifiedClick(event)) {
      return;
    }

    scheduleSidebarModeReconcile(5);
    const target = event.target instanceof Element ? event.target : null;
    if (target) {
      armSidebarModeInteractionIfToggleTrigger(target);
    }
  }

  function handleSidebarKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
      return;
    }

    scheduleSidebarModeReconcile(5);
    if (isSidebarToggleShortcut(event)) {
      armSidebarModeInteraction();
    }
  }

  function handleSidebarLayoutChange(): void {
    scheduleSidebarModeReconcile(5);
  }

  function handleNewThreadTriggerClick(event: MouseEvent): void {
    if (!isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const nearestInteractive = target.closest(
      'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
    );
    if (!nearestInteractive || !isNewThreadTrigger(nearestInteractive)) {
      return;
    }

    clearThreadQuery();
  }

  function handleLocalAttachmentPickerClick(event: MouseEvent): void {
    if (!isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const nearestMenuItem = target.closest('[role="menuitem"]');
    if (!nearestMenuItem || !isAddPhotosAndFilesMenuItem(nearestMenuItem)) {
      return;
    }

    const pickerResult = tryOpenComposerFileInput();
    if (!pickerResult.ok) {
      return;
    }

    event.preventDefault();
    stopEventPropagation(event);
    closeTransientMenus();
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

    if (isMobileSidebarThreadRow(nearestInteractive)) {
      scheduleMobileSidebarClose();
      return;
    }

    if (isNewThreadTrigger(nearestInteractive)) {
      clearThreadQuery();
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

  function isNewThreadTrigger(element: Element): boolean {
    if (element.tagName !== "BUTTON" && element.tagName !== "A") {
      return false;
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (ariaLabel === "new thread" || ariaLabel.startsWith("start new thread in ")) {
      return true;
    }

    const text = element.textContent?.trim().toLowerCase() ?? "";
    return text === "new thread";
  }

  function isAddPhotosAndFilesMenuItem(element: Element): boolean {
    if (element.getAttribute("role") !== "menuitem") {
      return false;
    }

    return element.textContent?.trim().toLowerCase() === "add photos & files";
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
        armSidebarModeInteraction();
        dispatchHostMessage({ type: "toggle-sidebar" });
        scheduleSidebarModeReconcile(5);
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
    const transform = typeof style?.transform === "string" ? style.transform.trim() : "";

    if (width !== "" || transform !== "") {
      const widthIndicatesOpen = width !== "" && width !== "100%";
      const transformIndicatesOpen =
        transform !== "" && transform !== "translateX(0)" && transform !== "translateX(0px)";
      return widthIndicatesOpen || transformIndicatesOpen;
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

  function startSidebarModeObserver(): void {
    if (sidebarModeObserver || typeof MutationObserver !== "function") {
      return;
    }

    sidebarModeObserver = new MutationObserver(() => {
      scheduleSidebarModeReconcile(2);
    });
    sidebarModeObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }

  function scheduleSidebarModeReconcile(retries = 0, delayMs = 0): void {
    sidebarModePendingRetries = Math.max(sidebarModePendingRetries, retries);
    if (sidebarModeReconcileTimer !== null) {
      return;
    }

    sidebarModeReconcileTimer = window.setTimeout(() => {
      const pendingRetries = sidebarModePendingRetries;
      sidebarModePendingRetries = 0;
      sidebarModeReconcileTimer = null;
      reconcileSidebarMode(pendingRetries);
    }, delayMs);
  }

  function reconcileSidebarMode(retriesRemaining: number): void {
    if (!hasReceivedSidebarModeSync) {
      if (retriesRemaining > 0) {
        scheduleSidebarModeReconcile(retriesRemaining - 1, 50);
      }
      return;
    }

    const desiredMode = sidebarModeFromHost ?? "expanded";
    const currentMode = readSidebarMode();
    if (!currentMode) {
      if (retriesRemaining > 0) {
        scheduleSidebarModeReconcile(retriesRemaining - 1, 50);
      }
      return;
    }

    if (pendingSidebarModeTarget) {
      if (currentMode === pendingSidebarModeTarget) {
        clearPendingSidebarModeTarget();
      } else if (Date.now() < pendingSidebarModeTargetUntil) {
        if (retriesRemaining > 0) {
          scheduleSidebarModeReconcile(retriesRemaining - 1, 50);
        }
        return;
      } else {
        clearPendingSidebarModeTarget();
      }
    }

    if (!hasRestoredSidebarMode) {
      if (currentMode !== desiredMode) {
        if (isSidebarModeInteractionArmed) {
          hasRestoredSidebarMode = true;
          persistSidebarMode(currentMode);
          return;
        }
        notePendingSidebarModeTarget(desiredMode);
        dispatchHostMessage({ type: "toggle-sidebar" });
        if (retriesRemaining > 0) {
          scheduleSidebarModeReconcile(retriesRemaining - 1, 50);
        }
        return;
      }

      hasRestoredSidebarMode = true;
    }

    if (currentMode === desiredMode) {
      return;
    }

    if (!isSidebarModeInteractionArmed) {
      notePendingSidebarModeTarget(desiredMode);
      dispatchHostMessage({ type: "toggle-sidebar" });
      if (retriesRemaining > 0) {
        scheduleSidebarModeReconcile(retriesRemaining - 1, 50);
      }
      return;
    }

    persistSidebarMode(currentMode);
  }

  function readSidebarMode(): SidebarMode | null {
    if (isMobileSidebarViewport()) {
      return isMobileSidebarOpen() ? "expanded" : "collapsed";
    }

    const contentPane = document.querySelector(".main-surface");
    if (!(contentPane instanceof Element)) {
      return null;
    }

    const className =
      typeof (contentPane as Element & { className?: string }).className === "string"
        ? ((contentPane as Element & { className?: string }).className ?? "").trim()
        : "";
    if (className.includes("left-token-sidebar")) {
      return "expanded";
    }
    if (className.split(/\s+/).includes("left-0")) {
      return "collapsed";
    }

    if (typeof contentPane.getBoundingClientRect !== "function") {
      return null;
    }

    const rect = contentPane.getBoundingClientRect();
    if (rect.left > 0.5) {
      return "expanded";
    }

    const viewportWidth = typeof window.innerWidth === "number" ? window.innerWidth : 0;
    if (viewportWidth > 0 && rect.width > 0 && rect.width < viewportWidth - 0.5) {
      return "expanded";
    }

    return "collapsed";
  }

  function readSidebarModeValue(value: unknown): SidebarMode | null {
    return value === "expanded" || value === "collapsed" ? value : null;
  }

  function armSidebarModeInteractionIfToggleTrigger(target: Element): void {
    const nearestInteractive = target.closest('button, a, [role="button"]');
    if (!(nearestInteractive instanceof Element)) {
      return;
    }

    if (!isSidebarToggleTrigger(nearestInteractive)) {
      return;
    }

    armSidebarModeInteraction();
  }

  function armSidebarModeInteraction(): void {
    clearPendingSidebarModeTarget();
    isSidebarModeInteractionArmed = true;
    if (sidebarModeInteractionTimer !== null) {
      window.clearTimeout(sidebarModeInteractionTimer);
    }
    sidebarModeInteractionTimer = window.setTimeout(() => {
      clearSidebarModeInteractionArm();
    }, SIDEBAR_INTERACTION_ARM_MS);
  }

  function clearSidebarModeInteractionArm(): void {
    isSidebarModeInteractionArmed = false;
    if (sidebarModeInteractionTimer !== null) {
      window.clearTimeout(sidebarModeInteractionTimer);
      sidebarModeInteractionTimer = null;
    }
  }

  function notePendingSidebarModeTarget(mode: SidebarMode): void {
    pendingSidebarModeTarget = mode;
    pendingSidebarModeTargetUntil = Date.now() + SIDEBAR_MODE_TOGGLE_SETTLE_MS;
  }

  function clearPendingSidebarModeTarget(): void {
    pendingSidebarModeTarget = null;
    pendingSidebarModeTargetUntil = 0;
  }

  function isSidebarToggleTrigger(element: Element): boolean {
    const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (ariaLabel === "hide sidebar" || ariaLabel === "show sidebar") {
      return true;
    }

    const title = element.getAttribute("title")?.trim().toLowerCase() ?? "";
    return title === "hide sidebar" || title === "show sidebar";
  }

  function isSidebarToggleShortcut(event: KeyboardEvent): boolean {
    const key = event.key?.trim().toLowerCase();
    if (key !== "b" || event.altKey || event.shiftKey) {
      return false;
    }

    const hasPrimaryModifier =
      (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey);
    return hasPrimaryModifier;
  }

  function persistSidebarMode(mode: SidebarMode): void {
    clearSidebarModeInteractionArm();
    sidebarModeFromHost = mode;
    sendEnvelope({
      type: "bridge_message",
      message: {
        type: "persisted-atom-update",
        key: SIDEBAR_MODE_PERSISTED_ATOM_KEY,
        value: mode,
      },
    });
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

  async function openWorkspaceRootPicker(
    context: WorkspaceRootPickerContext,
    initialPath: string,
  ): Promise<void> {
    workspaceRootPickerState = {
      context,
      currentPath: initialPath,
      parentPath: null,
      entries: [],
      pathInputValue: initialPath,
      errorMessage: null,
      hasOpenedPath: false,
      isLoading: true,
      isCreatingDirectory: false,
      isCancelling: false,
      isConfirming: false,
    };
    renderWorkspaceRootPicker();
    await loadWorkspaceRootPickerPath(initialPath);
  }

  function closeWorkspaceRootPicker(): void {
    workspaceRootPickerState = null;
    workspaceRootPickerHost.hidden = true;
    workspaceRootPickerHost.replaceChildren();
  }

  function renderWorkspaceRootPicker(): void {
    const state = workspaceRootPickerState;
    if (!state) {
      closeWorkspaceRootPicker();
      return;
    }

    ensureHostAttached(workspaceRootPickerHost);
    workspaceRootPickerHost.hidden = false;
    workspaceRootPickerHost.replaceChildren();

    const isBusy =
      state.isLoading || state.isCreatingDirectory || state.isCancelling || state.isConfirming;
    const canCloseOnboarding = state.context !== "onboarding" || state.hasOpenedPath;
    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexWorkspaceRootPickerBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexWorkspaceRootPickerDialog = "true";

    const header = document.createElement("div");
    header.dataset.pocodexWorkspaceRootPickerHeader = "true";

    const title = document.createElement("h2");
    title.textContent =
      state.context === "onboarding" ? "Choose a project folder" : "Add a project folder";

    const subtitle = document.createElement("p");
    subtitle.textContent =
      state.context === "onboarding"
        ? "Choose or create a folder on the Pocodex host to start working locally."
        : "Choose or create a folder on the Pocodex host to add it as a project.";

    header.append(title, subtitle);

    const pathForm = document.createElement("div");
    pathForm.dataset.pocodexWorkspaceRootPickerPathForm = "true";

    const pathLabel = document.createElement("label");
    pathLabel.dataset.pocodexWorkspaceRootPickerPathLabel = "true";
    pathLabel.textContent = "Folder path";

    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.value = state.pathInputValue;
    pathInput.placeholder = "~/project";
    pathInput.disabled = isBusy;
    pathInput.dataset.pocodexWorkspaceRootPickerPathInput = "true";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.dataset.pocodexWorkspaceRootPickerOpenButton = "true";
    openButton.textContent = state.isLoading ? "Loading..." : "Open";
    openButton.addEventListener("click", () => {
      void submitWorkspaceRootPickerPathInput();
    });

    const newFolderButton = document.createElement("button");
    newFolderButton.type = "button";
    newFolderButton.dataset.pocodexWorkspaceRootPickerNewFolderButton = "true";
    newFolderButton.textContent = state.isCreatingDirectory ? "Creating..." : "New folder";
    newFolderButton.disabled =
      isBusy || !canCreateWorkspaceRootPickerDirectory(state.pathInputValue, state.currentPath);
    newFolderButton.addEventListener("click", () => {
      void createWorkspaceRootPickerDirectory();
    });

    const syncPathActionButtons = (): void => {
      const currentState = workspaceRootPickerState ?? state;
      openButton.disabled = isBusy || currentState.pathInputValue.trim().length === 0;
      newFolderButton.disabled =
        isBusy ||
        !canCreateWorkspaceRootPickerDirectory(
          currentState.pathInputValue,
          currentState.currentPath,
        );
    };

    pathInput.addEventListener("input", () => {
      if (!workspaceRootPickerState) {
        return;
      }
      workspaceRootPickerState.pathInputValue = pathInput.value;
      syncPathActionButtons();
    });
    pathInput.addEventListener("keydown", (event) => {
      if (readEventKey(event) !== "Enter") {
        return;
      }
      event.preventDefault();
      void submitWorkspaceRootPickerPathInput();
    });
    syncPathActionButtons();

    pathLabel.appendChild(pathInput);
    pathForm.append(pathLabel, openButton, newFolderButton);

    const content = document.createElement("div");
    content.dataset.pocodexWorkspaceRootPickerContent = "true";

    if (state.errorMessage) {
      const errorText = document.createElement("p");
      errorText.dataset.pocodexWorkspaceRootPickerError = "true";
      errorText.textContent = state.errorMessage;
      content.appendChild(errorText);
    }

    const list = document.createElement("div");
    list.dataset.pocodexWorkspaceRootPickerList = "true";
    if (state.isLoading) {
      const loading = document.createElement("p");
      loading.dataset.pocodexWorkspaceRootPickerEmpty = "true";
      loading.textContent = "Loading folders...";
      list.appendChild(loading);
    } else {
      const rows: Array<{
        label: string;
        path: string;
        isParent?: boolean;
      }> = [];
      if (state.parentPath) {
        rows.push({
          label: "..",
          path: state.parentPath,
          isParent: true,
        });
      }
      for (const entry of state.entries) {
        rows.push({
          label: entry.name,
          path: entry.path,
        });
      }

      if (rows.length === 0) {
        const empty = document.createElement("p");
        empty.dataset.pocodexWorkspaceRootPickerEmpty = "true";
        empty.textContent = "This folder is empty.";
        list.appendChild(empty);
      }

      for (const rowConfig of rows) {
        const row = document.createElement("button");
        row.type = "button";
        row.dataset.pocodexWorkspaceRootPickerRow = "true";
        if (rowConfig.isParent) {
          row.dataset.pocodexWorkspaceRootPickerParentRow = "true";
        }
        row.textContent = rowConfig.label;
        row.disabled = isBusy;
        row.addEventListener("click", () => {
          void loadWorkspaceRootPickerPath(rowConfig.path);
        });
        list.appendChild(row);
      }
    }
    content.appendChild(list);

    const footer = document.createElement("div");
    footer.dataset.pocodexWorkspaceRootPickerFooter = "true";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.dataset.pocodexWorkspaceRootPickerCancelButton = "true";
    cancelButton.textContent = state.isCancelling ? "Cancelling..." : "Cancel";
    cancelButton.disabled = isBusy || !canCloseOnboarding;
    cancelButton.addEventListener("click", () => {
      void cancelWorkspaceRootPicker();
    });

    const useFolderButton = document.createElement("button");
    useFolderButton.type = "button";
    useFolderButton.dataset.pocodexWorkspaceRootPickerUseFolderButton = "true";
    useFolderButton.dataset.variant = "primary";
    useFolderButton.textContent = state.isConfirming ? "Using..." : "Use folder";
    useFolderButton.disabled = isBusy || state.pathInputValue.trim().length === 0;
    useFolderButton.addEventListener("click", () => {
      void confirmWorkspaceRootPickerSelection();
    });

    footer.append(cancelButton, useFolderButton);
    dialog.append(header, pathForm, content, footer);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (readEventTarget(event) !== backdrop) {
        return;
      }
      if (!canCloseOnboarding) {
        return;
      }
      void cancelWorkspaceRootPicker();
    });

    workspaceRootPickerHost.appendChild(backdrop);
  }

  async function submitWorkspaceRootPickerPathInput(): Promise<void> {
    const state = workspaceRootPickerState;
    if (!state) {
      return;
    }

    await loadWorkspaceRootPickerPath(state.pathInputValue);
  }

  async function loadWorkspaceRootPickerPath(path: string): Promise<void> {
    if (!workspaceRootPickerState) {
      return;
    }

    workspaceRootPickerState.isLoading = true;
    workspaceRootPickerState.errorMessage = null;
    renderWorkspaceRootPicker();

    try {
      const result = await callPocodexIpc("workspace-root-picker/list", {
        path,
      });
      if (!isWorkspaceRootPickerListResult(result)) {
        throw new Error("Failed to load folders.");
      }
      if (!workspaceRootPickerState) {
        return;
      }

      workspaceRootPickerState.currentPath = result.currentPath;
      workspaceRootPickerState.parentPath = result.parentPath;
      workspaceRootPickerState.entries = result.entries;
      workspaceRootPickerState.pathInputValue = result.currentPath;
      workspaceRootPickerState.errorMessage = null;
      workspaceRootPickerState.hasOpenedPath = true;
    } catch (error) {
      if (!workspaceRootPickerState) {
        return;
      }
      workspaceRootPickerState.errorMessage =
        error instanceof Error ? error.message : "Failed to load folders.";
    } finally {
      if (workspaceRootPickerState) {
        workspaceRootPickerState.isLoading = false;
        renderWorkspaceRootPicker();
      }
    }
  }

  async function createWorkspaceRootPickerDirectory(): Promise<void> {
    const state = workspaceRootPickerState;
    if (!state) {
      return;
    }

    state.isCreatingDirectory = true;
    state.errorMessage = null;
    renderWorkspaceRootPicker();

    try {
      const { parentPath, name } = readWorkspaceRootPickerCreateTarget(state.pathInputValue);
      const result = await callPocodexIpc("workspace-root-picker/create-directory", {
        parentPath,
        name,
      });
      const currentPath = readWorkspaceRootPickerCurrentPath(result);
      if (!currentPath) {
        throw new Error("Failed to create folder.");
      }
      if (!workspaceRootPickerState) {
        return;
      }

      workspaceRootPickerState.isCreatingDirectory = false;
      renderWorkspaceRootPicker();
      await loadWorkspaceRootPickerPath(currentPath);
    } catch (error) {
      if (!workspaceRootPickerState) {
        return;
      }
      workspaceRootPickerState.isCreatingDirectory = false;
      workspaceRootPickerState.errorMessage =
        error instanceof Error ? error.message : "Failed to create folder.";
      renderWorkspaceRootPicker();
    }
  }

  async function confirmWorkspaceRootPickerSelection(): Promise<void> {
    const state = workspaceRootPickerState;
    if (!state) {
      return;
    }

    state.isConfirming = true;
    state.errorMessage = null;
    renderWorkspaceRootPicker();

    try {
      const result = await callPocodexIpc("workspace-root-picker/confirm", {
        path: state.pathInputValue,
        context: state.context,
      });
      const action = readWorkspaceRootPickerConfirmAction(result);
      closeWorkspaceRootPicker();
      showNotice(action === "added" ? "Added project folder." : "Switched to project folder.");
    } catch (error) {
      if (!workspaceRootPickerState) {
        return;
      }
      workspaceRootPickerState.isConfirming = false;
      workspaceRootPickerState.errorMessage =
        error instanceof Error ? error.message : "Failed to use this folder.";
      renderWorkspaceRootPicker();
    }
  }

  async function cancelWorkspaceRootPicker(): Promise<void> {
    const state = workspaceRootPickerState;
    if (!state) {
      return;
    }

    if (state.context !== "onboarding") {
      closeWorkspaceRootPicker();
      return;
    }
    if (!state.hasOpenedPath) {
      return;
    }

    state.isCancelling = true;
    state.errorMessage = null;
    renderWorkspaceRootPicker();

    try {
      await callPocodexIpc("workspace-root-picker/cancel", {
        context: state.context,
      });
      closeWorkspaceRootPicker();
    } catch (error) {
      if (!workspaceRootPickerState) {
        return;
      }
      workspaceRootPickerState.isCancelling = false;
      workspaceRootPickerState.errorMessage =
        error instanceof Error ? error.message : "Failed to cancel project folder selection.";
      renderWorkspaceRootPicker();
    }
  }

  function normalizeWorkspaceRootPickerPathInput(path: string): string {
    const trimmedPath = path.trim();
    if (
      trimmedPath.length === 0 ||
      trimmedPath === "/" ||
      trimmedPath === "~" ||
      /^[A-Za-z]:[\\/]?$/.test(trimmedPath) ||
      /^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(trimmedPath)
    ) {
      return trimmedPath;
    }

    return trimmedPath.replace(/[\\/]+$/, "");
  }

  function isAbsoluteWorkspaceRootPickerPath(path: string): boolean {
    return (
      path.startsWith("/") ||
      path === "~" ||
      path.startsWith("~/") ||
      path.startsWith("~\\") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path)
    );
  }

  function canCreateWorkspaceRootPickerDirectory(path: string, currentPath: string): boolean {
    const normalizedPath = normalizeWorkspaceRootPickerPathInput(path);
    if (
      normalizedPath.length === 0 ||
      normalizedPath === normalizeWorkspaceRootPickerPathInput(currentPath)
    ) {
      return false;
    }

    try {
      readWorkspaceRootPickerCreateTarget(normalizedPath);
      return true;
    } catch {
      return false;
    }
  }

  function readWorkspaceRootPickerCreateTarget(path: string): {
    parentPath: string;
    name: string;
  } {
    const normalizedPath = normalizeWorkspaceRootPickerPathInput(path);
    if (normalizedPath.length === 0) {
      throw new Error("Enter a folder path.");
    }
    if (!isAbsoluteWorkspaceRootPickerPath(normalizedPath)) {
      throw new Error("Enter an absolute folder path.");
    }
    if (
      normalizedPath === "/" ||
      normalizedPath === "~" ||
      /^[A-Za-z]:[\\/]?$/.test(normalizedPath) ||
      /^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(normalizedPath)
    ) {
      throw new Error("Choose a new folder path.");
    }

    const lastSeparatorIndex = Math.max(
      normalizedPath.lastIndexOf("/"),
      normalizedPath.lastIndexOf("\\"),
    );
    if (lastSeparatorIndex < 0) {
      throw new Error("Enter an absolute folder path.");
    }

    const separator = normalizedPath[lastSeparatorIndex] ?? "/";
    let parentPath = normalizedPath.slice(0, lastSeparatorIndex);
    const name = normalizedPath.slice(lastSeparatorIndex + 1).trim();
    if (name.length === 0) {
      throw new Error("Choose a new folder path.");
    }

    if (parentPath.length === 0 && normalizedPath.startsWith("/")) {
      parentPath = "/";
    } else if (/^[A-Za-z]:$/.test(parentPath)) {
      parentPath = `${parentPath}${separator}`;
    }

    return {
      parentPath,
      name,
    };
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

  function findComposerFileInput(): {
    click: () => void;
    getAttribute(name: string): string | null;
    multiple?: boolean;
    type?: string;
  } | null {
    const candidate = document.querySelector('input[type="file"]');
    if (!isRecord(candidate) || typeof candidate.click !== "function") {
      return null;
    }

    const click = candidate.click;
    const getAttribute =
      typeof candidate.getAttribute === "function"
        ? candidate.getAttribute.bind(candidate)
        : (_name: string) => null;
    const type = typeof candidate.type === "string" ? candidate.type : getAttribute("type");
    const isMultiple = candidate.multiple === true || getAttribute("multiple") !== null;
    if (type !== "file" || !isMultiple) {
      return null;
    }

    return {
      click: () => {
        click.call(candidate);
      },
      getAttribute,
      multiple: candidate.multiple === true,
      type: type ?? undefined,
    };
  }

  function tryOpenComposerFileInput(): { ok: true } | { ok: false; error: string } {
    const fileInput = findComposerFileInput();
    if (!fileInput) {
      return {
        ok: false,
        error: "Unable to locate browser file input.",
      };
    }

    fileInput.click();
    return { ok: true };
  }

  function stopEventPropagation(event: unknown): void {
    if (isRecord(event) && typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
      return;
    }

    if (isRecord(event) && typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
  }

  function closeTransientMenus(): void {
    if (typeof KeyboardEvent !== "function") {
      return;
    }

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
  }

  function isWorkspaceRootPickerListResult(value: unknown): value is WorkspaceRootPickerListResult {
    return (
      isRecord(value) &&
      typeof value.currentPath === "string" &&
      (value.parentPath === null || typeof value.parentPath === "string") &&
      typeof value.homePath === "string" &&
      Array.isArray(value.entries) &&
      value.entries.every(
        (entry) =>
          isRecord(entry) && typeof entry.name === "string" && typeof entry.path === "string",
      )
    );
  }

  function readWorkspaceRootPickerCurrentPath(result: unknown): string | null {
    return isRecord(result) && typeof result.currentPath === "string" ? result.currentPath : null;
  }

  function readWorkspaceRootPickerConfirmAction(result: unknown): "activated" | "added" {
    return isRecord(result) && result.action === "activated" ? "activated" : "added";
  }

  function readEventKey(event: unknown): string {
    return isRecord(event) && typeof event.key === "string" ? event.key : "";
  }

  function readEventTarget(event: unknown): EventTarget | null {
    return isRecord(event) && "target" in event ? (event.target as EventTarget | null) : null;
  }

  function dispatchHostMessage(message: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  function syncSidebarModeWithBridgeMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? message.state : {};
      sidebarModeFromHost = readSidebarModeValue(state[SIDEBAR_MODE_PERSISTED_ATOM_KEY]);
      clearPendingSidebarModeTarget();
      hasReceivedSidebarModeSync = true;
      hasRestoredSidebarMode = false;
      scheduleSidebarModeReconcile(20);
      return;
    }

    if (
      message.type === "persisted-atom-updated" &&
      message.key === SIDEBAR_MODE_PERSISTED_ATOM_KEY
    ) {
      sidebarModeFromHost = message.deleted === true ? null : readSidebarModeValue(message.value);
      clearPendingSidebarModeTarget();
      hasReceivedSidebarModeSync = true;
      hasRestoredSidebarMode = false;
      scheduleSidebarModeReconcile(20);
    }
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

    if (message.type === "pocodex-open-workspace-root-picker") {
      const context = message.context === "onboarding" ? "onboarding" : "manual";
      const initialPath = typeof message.initialPath === "string" ? message.initialPath : "";
      void openWorkspaceRootPicker(context, initialPath);
      return true;
    }

    return false;
  }

  function normalizeBrowserUrlForRefresh(): void {
    const currentUrl = new URL(window.location.href);
    const legacyInitialRoute = readLegacyInitialRoute(currentUrl);
    const hasNonLocalLegacyInitialRoute =
      legacyInitialRoute !== null &&
      extractLocalConversationIdFromRoute(legacyInitialRoute) === null;
    const conversationId =
      readThreadQueryConversationId(currentUrl) ??
      extractLocalConversationIdFromRoute(legacyInitialRoute) ??
      extractLocalConversationIdFromRoute(currentUrl.pathname);
    if (conversationId) {
      replaceThreadQuery(conversationId);
      return;
    }

    if (currentUrl.searchParams.has(THREAD_QUERY_KEY)) {
      replaceThreadQuery(null, {
        preserveLegacyInitialRoute: hasNonLocalLegacyInitialRoute,
      });
      return;
    }

    if (
      currentUrl.searchParams.has(LEGACY_INITIAL_ROUTE_QUERY_KEY) &&
      !hasNonLocalLegacyInitialRoute
    ) {
      clearThreadQuery();
    }
  }

  function readThreadQueryConversationId(url: URL = new URL(window.location.href)): string | null {
    return normalizeRestorableConversationId(url.searchParams.get(THREAD_QUERY_KEY));
  }

  function readLegacyInitialRoute(url: URL = new URL(window.location.href)): string | null {
    const initialRoute = url.searchParams.get(LEGACY_INITIAL_ROUTE_QUERY_KEY)?.trim();
    return initialRoute ? initialRoute : null;
  }

  function getServedPathname(url: URL): string {
    return url.pathname === INDEX_HTML_PATHNAME ? INDEX_HTML_PATHNAME : "/";
  }

  function replaceThreadQuery(
    conversationId: string | null,
    options: {
      preserveLegacyInitialRoute?: boolean;
    } = {},
  ): void {
    const currentUrl = new URL(window.location.href);
    const nextUrl = new URL(currentUrl.toString());
    nextUrl.pathname = getServedPathname(currentUrl);
    if (!options.preserveLegacyInitialRoute) {
      nextUrl.searchParams.delete(LEGACY_INITIAL_ROUTE_QUERY_KEY);
    }
    if (conversationId) {
      nextUrl.searchParams.set(THREAD_QUERY_KEY, conversationId);
    } else {
      nextUrl.searchParams.delete(THREAD_QUERY_KEY);
    }

    if (nextUrl.toString() === currentUrl.toString()) {
      return;
    }

    window.history.replaceState(null, "", nextUrl.toString());
  }

  function buildLocalConversationRoute(conversationId: string): string {
    return `${LOCAL_THREAD_ROUTE_PREFIX}${encodeURIComponent(conversationId)}`;
  }

  function setThreadQueryForConversation(conversationId: string): void {
    replaceThreadQuery(conversationId);
  }

  function clearThreadQuery(): void {
    replaceThreadQuery(null);
  }

  function extractLocalConversationIdFromRoute(route: string | null): string | null {
    if (!route) {
      return null;
    }

    const trimmedRoute = route.trim();
    if (!trimmedRoute.startsWith(LOCAL_THREAD_ROUTE_PREFIX)) {
      return null;
    }

    const remainingRoute = trimmedRoute.slice(LOCAL_THREAD_ROUTE_PREFIX.length);
    const separatorIndex = remainingRoute.search(/[/?#]/);
    const encodedConversationId =
      separatorIndex === -1 ? remainingRoute : remainingRoute.slice(0, separatorIndex);
    if (!encodedConversationId) {
      return null;
    }

    try {
      return decodeURIComponent(encodedConversationId);
    } catch {
      return encodedConversationId;
    }
  }

  function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmedValue = value.trim();
    return trimmedValue.length > 0 ? trimmedValue : null;
  }

  function normalizeRestorableConversationId(value: unknown): string | null {
    const conversationId = readNonEmptyString(value);
    if (!conversationId || conversationId.startsWith("home:")) {
      return null;
    }

    return conversationId;
  }

  function readConversationIdFromBridgeMessage(
    message: Record<string, unknown> & { type: string },
  ): string | null {
    if (
      message.type === "thread-role-request" ||
      message.type === "terminal-create" ||
      message.type === "terminal-attach" ||
      message.type.startsWith("thread-follower-")
    ) {
      return readNonEmptyString(message.conversationId);
    }

    return null;
  }

  function syncThreadQueryWithBridgeMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    const typedMessage = message as Record<string, unknown> & { type: string };
    const rawConversationId = readConversationIdFromBridgeMessage(typedMessage);
    if (rawConversationId) {
      const conversationId = normalizeRestorableConversationId(rawConversationId);
      if (conversationId) {
        setThreadQueryForConversation(conversationId);
      }
      return;
    }

    switch (typedMessage.type) {
      case "navigate-to-route": {
        const path = readNonEmptyString(typedMessage.path);
        if (!path) {
          return;
        }

        const routeConversationId = extractLocalConversationIdFromRoute(path);
        if (routeConversationId) {
          const conversationId = normalizeRestorableConversationId(routeConversationId);
          if (conversationId) {
            setThreadQueryForConversation(conversationId);
          } else {
            clearThreadQuery();
          }
          return;
        }

        clearThreadQuery();
        return;
      }
      case "new-chat":
        clearThreadQuery();
        return;
      default:
        return;
    }
  }

  function scheduleInitialThreadRestoreFromUrl(): void {
    if (hasScheduledInitialThreadRestore) {
      return;
    }

    const conversationId = readThreadQueryConversationId();
    if (!conversationId) {
      return;
    }

    hasScheduledInitialThreadRestore = true;
    window.setTimeout(() => {
      dispatchHostMessage({
        type: "navigate-to-route",
        path: buildLocalConversationRoute(conversationId),
      });
      dispatchHostMessage({
        type: "thread-stream-resume-request",
        hostId: LOCAL_HOST_ID,
        conversationId,
      });
    }, 0);
  }

  function getStoredToken(): string {
    const url = new URL(window.location.href);
    const tokenFromQuery = url.searchParams.get("token")?.trim();
    if (tokenFromQuery) {
      persistSessionToken(tokenFromQuery);
      return tokenFromQuery;
    }
    return readStoredTokenValue("sessionStorage") || readStoredTokenValue("localStorage");
  }

  async function registerPwaServiceWorker(): Promise<void> {
    if (config.devMode) {
      return;
    }

    const navigatorObject = window.navigator as
      | {
          serviceWorker?: {
            register?: (
              scriptUrl: string,
              options?: { scope?: string; updateViaCache?: "all" | "imports" | "none" },
            ) => Promise<unknown>;
          };
        }
      | undefined;
    if (
      !navigatorObject?.serviceWorker ||
      typeof navigatorObject.serviceWorker.register !== "function"
    ) {
      return;
    }

    try {
      await navigatorObject.serviceWorker.register(POCODEX_SERVICE_WORKER_PATH, {
        scope: "/",
        updateViaCache: "none",
      });
    } catch {
      // Service workers require a secure context outside localhost. Ignore failures silently.
    }
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

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return;
    }

    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearHeartbeatMonitor(): void {
    if (heartbeatMonitorTimer === null) {
      return;
    }

    window.clearTimeout(heartbeatMonitorTimer);
    heartbeatMonitorTimer = null;
  }

  function isDocumentVisible(): boolean {
    return document.visibilityState === "visible";
  }

  function hasDocumentFocus(): boolean {
    return typeof document.hasFocus === "function" ? document.hasFocus() : true;
  }

  function isNetworkOnline(): boolean {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  function isWakeGraceActive(): boolean {
    return Date.now() < wakeGraceDeadline;
  }

  function enterWakeGracePeriod(): void {
    wakeGraceDeadline = Date.now() + WAKE_GRACE_PERIOD_MS;
  }

  function startHeartbeatMonitor(): void {
    clearHeartbeatMonitor();

    const poll = () => {
      heartbeatMonitorTimer = window.setTimeout(poll, HEARTBEAT_MONITOR_INTERVAL_MS);

      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        !isDocumentVisible() ||
        !isNetworkOnline() ||
        isWakeGraceActive()
      ) {
        return;
      }

      if (Date.now() - lastServerHeartbeatAt <= HEARTBEAT_STALE_AFTER_MS) {
        return;
      }

      if (connectionPhase === "connected") {
        setConnectionPhase("degraded", "Pocodex connection looks stale. Reconnecting...", {
          mode: "passive",
        });
      }

      socket.close(4000, "heartbeat-timeout");
    };

    heartbeatMonitorTimer = window.setTimeout(poll, HEARTBEAT_MONITOR_INTERVAL_MS);
  }

  function scheduleReconnect(
    message: string,
    options: {
      immediate?: boolean;
      passive?: boolean;
      suppressEscalation?: boolean;
    } = {},
  ): void {
    clearReconnectTimer();

    const shouldEscalate = !options.suppressEscalation && isDocumentVisible() && isNetworkOnline();
    if (shouldEscalate) {
      reconnectAttempt += 1;
    }

    const delay = options.immediate
      ? 0
      : RETRY_DELAYS_MS[Math.min(reconnectAttempt, RETRY_DELAYS_MS.length - 1)];
    const nextPhase =
      reconnectAttempt >= RELOAD_REQUIRED_FAILURE_COUNT && shouldEscalate
        ? "reload-required"
        : "reconnecting";
    const nextMessage =
      nextPhase === "reload-required"
        ? "Pocodex is still reconnecting. Keep this page open, or refresh it if the connection does not recover."
        : message;

    setConnectionPhase(nextPhase, nextMessage, {
      mode: options.passive || nextPhase !== "reload-required" ? "passive" : "blocking",
    });

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connectSocket();
    }, applyReconnectJitter(delay));
  }

  function applyReconnectJitter(delay: number): number {
    if (delay <= 0) {
      return 0;
    }

    return Math.max(0, Math.round(delay * (0.85 + Math.random() * 0.3)));
  }

  function noteHealthyConnection(): void {
    reconnectAttempt = 0;
    lastServerHeartbeatAt = Date.now();
    setConnectionPhase("connected");
    clearReconnectTimer();
    startHeartbeatMonitor();
  }

  function noteServerHeartbeat(sentAt: number): void {
    lastServerHeartbeatAt = Date.now();
    if (connectionPhase === "degraded") {
      setConnectionPhase("connected");
    }

    sendEnvelope({
      type: "heartbeat_ack",
      sentAt,
    });
  }

  function describeReconnectReason(closeEvent?: { code?: number; reason?: string }): string {
    if (!isNetworkOnline()) {
      return "Pocodex is offline. Waiting for network...";
    }

    if (!isDocumentVisible()) {
      return "Pocodex is paused while this tab is in the background. Reconnecting when it wakes...";
    }

    if (closeEvent?.code === 4000 || closeEvent?.reason === "heartbeat-timeout") {
      return "Pocodex connection timed out. Reconnecting...";
    }

    return "Pocodex lost the host connection. Retrying...";
  }

  function handleLifecycleReconnect(reason: string): void {
    enterWakeGracePeriod();

    if (!socket || socket.readyState === WebSocket.CLOSED) {
      scheduleReconnect(reason, {
        immediate: true,
        passive: true,
        suppressEscalation: !isDocumentVisible() || !isNetworkOnline(),
      });
      return;
    }

    if (socket.readyState === WebSocket.OPEN) {
      lastServerHeartbeatAt = Date.now();
      publishFocusState();
    }
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
      isFocused: isDocumentVisible() && hasDocumentFocus(),
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
    clearReconnectTimer();
    setConnectionPhase(
      "reconnecting",
      hasConnected ? "Reconnecting to Pocodex..." : "Connecting to Pocodex...",
      { mode: "passive" },
    );

    const validation = await validateSessionToken(token);
    if (!validation.ok) {
      isConnecting = false;
      if (validation.reason === "unauthorized") {
        persistSessionToken("");
        setConnectionPhase(
          "reload-required",
          token
            ? "Pocodex rejected this token. Open the exact URL printed by the CLI for the current run."
            : "Pocodex requires a token. Open the exact URL printed by the CLI for the current run.",
        );
        return;
      }
      scheduleReconnect("Pocodex is unavailable. Retrying...", {
        passive: true,
        suppressEscalation: !isDocumentVisible() || !isNetworkOnline(),
      });
      return;
    }

    enterWakeGracePeriod();
    socket = new WebSocket(getSocketUrl(token));
    socket.addEventListener("open", () => {
      isConnecting = false;
      hasConnected = true;
      noteHealthyConnection();
      flushPendingMessages();
      publishFocusState();
      for (const workerName of workerSubscribers.keys()) {
        sendEnvelope({ type: "worker_subscribe", workerName });
      }
    });

    socket.addEventListener("error", () => {
      if (!hasConnected) {
        setConnectionPhase(
          "reload-required",
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
            syncSidebarModeWithBridgeMessage(bridgeMessage);
            syncThreadQueryWithBridgeMessage(bridgeMessage);
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
        case "heartbeat":
          noteServerHeartbeat(envelope.sentAt);
          break;
        case "session_revoked":
          showNotice(envelope.reason || "This Pocodex session is no longer available.");
          setConnectionPhase(
            "reload-required",
            envelope.reason || "This Pocodex session is no longer available.",
          );
          isClosing = true;
          clearReconnectTimer();
          clearHeartbeatMonitor();
          socket?.close(4001, "revoked");
          break;
        case "error":
          showNotice(envelope.message);
          break;
      }
    });

    socket.addEventListener("close", (event) => {
      const shouldReconnect = !isClosing;
      socket = null;
      isConnecting = false;
      clearHeartbeatMonitor();
      if (!shouldReconnect) {
        return;
      }
      const message = describeReconnectReason(event);
      if (isDocumentVisible() && isNetworkOnline()) {
        showNotice(message);
      }
      scheduleReconnect(message, {
        passive: true,
        suppressEscalation: !isDocumentVisible() || !isNetworkOnline() || isWakeGraceActive(),
      });
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
      case "heartbeat":
        return typeof value.sentAt === "number";
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
          isFocused: isDocumentVisible() && hasDocumentFocus(),
        });
        return;
      }
      sendEnvelope({ type: "bridge_message", message });
      syncThreadQueryWithBridgeMessage(message);
      if (isRecord(message) && message.type === "ready") {
        scheduleInitialThreadRestoreFromUrl();
      }
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

  window.addEventListener("focus", () => {
    publishFocusState();
    handleLifecycleReconnect("Pocodex is reconnecting after the page became active.");
  });
  window.addEventListener("blur", publishFocusState);
  window.addEventListener("pageshow", () => {
    handleLifecycleReconnect("Pocodex is reconnecting after the page resumed.");
  });
  window.addEventListener("online", () => {
    handleLifecycleReconnect("Pocodex is back online. Reconnecting...");
  });
  window.addEventListener("offline", () => {
    setConnectionPhase("degraded", "Pocodex is offline. Waiting for network...", {
      mode: "passive",
    });
  });
  document.addEventListener("visibilitychange", () => {
    publishFocusState();
    if (isDocumentVisible()) {
      handleLifecycleReconnect("Pocodex is reconnecting after the page became visible.");
    }
  });
  window.addEventListener(
    "beforeunload",
    () => {
      isClosing = true;
      clearReconnectTimer();
      clearHeartbeatMonitor();
      if (socket) {
        socket.close(1000, "unload");
      }
    },
    { once: true },
  );

  void registerPwaServiceWorker();
  void connectSocket();
}
