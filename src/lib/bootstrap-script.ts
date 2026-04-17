import type {
  BrowserToServerEnvelope,
  SentryInitOptions,
  ServerToBrowserEnvelope,
} from "./protocol.js";
import { serializeInlineScript } from "./inline-script.js";

export interface BootstrapScriptConfig {
  authState?: {
    accountId: string | null;
    email: string | null;
    userId: string | null;
  } | null;
  devMode?: boolean;
  sentryOptions: SentryInitOptions;
  stylesheetHref: string;
  importIconSvg?: string;
}

export function renderBootstrapScript(config: BootstrapScriptConfig): string {
  return serializeInlineScript(bootstrapPocodexInBrowser, config);
}

function bootstrapPocodexInBrowser(config: BootstrapScriptConfig): void {
  type ConnectionStatusAction = {
    id: "reconnect" | "reload";
    label: string;
    style?: "primary" | "secondary";
    onClick: () => void;
  };

  type ConnectionStatusOptions = {
    mode?: string;
    actions?: ConnectionStatusAction[];
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

  type WorkspaceRootDialogMode = "add" | "pick";

  type WorkspaceRootAddResult = {
    success: boolean;
    root: string;
    error?: string;
  };

  type WorkspaceRootBrowserEntry = {
    name: string;
    path: string;
  };

  type WorkspaceRootBrowserResult = {
    root: string;
    parentRoot: string | null;
    homeDir: string;
    entries: WorkspaceRootBrowserEntry[];
  };

  type RestorableTerminalAttachment = {
    sessionId: string;
    conversationId: string | null;
    cwd: string | null;
    cols: number | null;
    rows: number | null;
    forceCwdSync: boolean;
  };

  type SessionValidationResult =
    | { ok: true }
    | { ok: false; reason: "unauthorized" | "unavailable" };

  type WorkerMessageListener = (message: unknown) => void;

  interface ElectronBridge {
    windowType: "electron";
    sendMessageFromView(message: unknown): Promise<void>;
    getPathForFile(): null;
    getSharedObjectSnapshotValue?(key: string): unknown;
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
  const LAST_ROUTE_STORAGE_KEY = "__pocodex_last_route";
  const ENTER_BEHAVIOR_ATOM_KEY = "enter-behavior";
  const ENTER_BEHAVIOR_NEWLINE = "newline";
  const SOFT_KEYBOARD_INSET_THRESHOLD_PX = 120;
  const RETRY_DELAYS_MS = [1000, 2000, 5000, 8000, 12000] as const;
  const SESSION_CHECK_PATH = "/session-check";
  const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 640px), (pointer: coarse) and (max-width: 900px)";
  const LEGACY_SIDEBAR_MODE_PERSISTED_ATOM_KEY = "pocodex-sidebar-mode";
  const SIDEBAR_INTERACTION_ARM_MS = 500;
  const SIDEBAR_MODE_TOGGLE_SETTLE_MS = 350;
  const HEARTBEAT_STALE_AFTER_MS = 45_000;
  const HEARTBEAT_MONITOR_INTERVAL_MS = 5_000;
  const WAKE_GRACE_PERIOD_MS = 10_000;
  const RELOAD_REQUIRED_FAILURE_COUNT = 6;
  const NON_TEXT_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);

  const workerSubscribers = new Map<string, Set<WorkerMessageListener>>();
  const restorableTerminalAttachments = new Map<string, RestorableTerminalAttachment>();
  const sharedObjectSnapshots = new Map<string, unknown>([
    [
      "host_config",
      {
        id: LOCAL_HOST_ID,
        display_name: "Local",
        kind: "local",
      },
    ],
    ["pocodex_auth_state", config.authState ?? null],
    ["remote_connections", []],
  ]);
  const pendingMessages: string[] = [];
  const toastHost = document.createElement("div");
  const statusHost = document.createElement("div");
  const importHost = document.createElement("div");
  const workspaceRootPickerHost = document.createElement("div");

  let socket: WebSocket | null = null;
  let isConnecting = false;
  let reconnectAttempt = 0;
  let isClosing = false;
  let isOpenInAppObserverStarted = false;
  let isEnterBehaviorOverrideObserverStarted = false;
  let hasConnected = false;
  let hasSeenHostEnterBehavior = false;
  let hostEnterBehaviorDeleted = true;
  let hostEnterBehaviorValue: unknown = undefined;
  let hasDispatchedEnterBehavior = false;
  let dispatchedEnterBehaviorDeleted = true;
  let dispatchedEnterBehaviorValue: unknown = undefined;
  let nextIpcRequestId = 0;
  let connectionPhase: ConnectionPhase = "reconnecting";
  let reconnectTimer: number | null = null;
  let heartbeatMonitorTimer: number | null = null;
  let lastServerHeartbeatAt = 0;
  let wakeGraceDeadline = 0;
  let pendingManualReconnect = false;
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
  let settingsShellObserver: MutationObserver | null = null;
  let workspaceRootPickerState: WorkspaceRootPickerState | null = null;

  toastHost.id = "pocodex-toast-host";
  statusHost.id = "pocodex-status-host";
  importHost.id = "pocodex-import-host";
  importHost.hidden = true;
  workspaceRootPickerHost.id = "pocodex-workspace-root-picker-host";
  workspaceRootPickerHost.hidden = true;
  document.documentElement.dataset.pocodex = "true";
  getStoredToken();
  restoreStoredRouteIfNeeded();
  normalizeBrowserUrlForRefresh();
  syncRouteDataset();
  installRoutePersistence();
  installEnterBehaviorOverrideObservers();

  runWhenDocumentReady(() => {
    ensureStylesheetLink(config.stylesheetHref);
    ensureHostAttached(toastHost);
    ensureHostAttached(statusHost);
    ensureHostAttached(workspaceRootPickerHost);
    installRouteDatasetSync();
    installSettingsShellObserver();
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

    if (options.actions && options.actions.length > 0) {
      const actions = document.createElement("div");
      actions.dataset.pocodexStatusActions = "true";

      for (const action of options.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        button.dataset.pocodexStatusAction = action.id;
        button.dataset.pocodexStatusStyle = action.style ?? "secondary";
        button.addEventListener("click", () => {
          action.onClick();
        });
        actions.appendChild(button);
      }

      card.appendChild(actions);
    }

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

    setConnectionStatus(message, {
      ...options,
      actions: options.actions ?? buildConnectionStatusActions(phase),
    });
  }

  function buildConnectionStatusActions(phase: ConnectionPhase): ConnectionStatusAction[] {
    if (phase === "connected") {
      return [];
    }

    const reconnectAction: ConnectionStatusAction | null = isClosing
      ? null
      : {
          id: "reconnect",
          label: phase === "reload-required" ? "Retry connection" : "Reconnect now",
          style: phase === "reload-required" ? "secondary" : "primary",
          onClick: reconnectNow,
        };
    const reloadAction: ConnectionStatusAction = {
      id: "reload",
      label: "Reload app",
      style: phase === "reload-required" || reconnectAction === null ? "primary" : "secondary",
      onClick: reloadCurrentPage,
    };

    return reconnectAction ? [reconnectAction, reloadAction] : [reloadAction];
  }

  function installMobileSidebarThreadNavigationClose(): void {
    document.addEventListener("click", handleMobileSidebarThreadClick, true);
    document.addEventListener("click", handleMobileContentPaneClick, true);
  }

  function installSidebarModePersistence(): void {
    sidebarModeFromHost = readSidebarModeFromBrowserStorage();
    hasReceivedSidebarModeSync = sidebarModeFromHost !== null;
    document.addEventListener("click", handleSidebarClick, true);
    document.addEventListener("keydown", handleSidebarKeydown, true);
    window.addEventListener("resize", handleSidebarLayoutChange);
    startSidebarModeObserver();
    scheduleSidebarModeReconcile(20);
  }

  function installRouteDatasetSync(): void {
    syncRouteDataset();

    const historyObject = window.history as History & {
      __pocodexRouteSyncInstalled?: boolean;
    };
    if (historyObject.__pocodexRouteSyncInstalled) {
      return;
    }

    historyObject.__pocodexRouteSyncInstalled = true;

    const wrapHistoryMethod = (methodName: "pushState" | "replaceState"): void => {
      const original = historyObject[methodName];
      if (typeof original !== "function") {
        return;
      }

      historyObject[methodName] = ((data: unknown, unused: string, url?: string | URL | null) => {
        original.call(window.history, data, unused, url);
        syncRouteDataset();
      }) as History[typeof methodName];
    };

    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
    window.addEventListener("popstate", syncRouteDataset);
    window.addEventListener("hashchange", syncRouteDataset);
  }

  function installNewThreadNavigationSync(): void {
    document.addEventListener("click", handleNewThreadTriggerClick, true);
  }

  function installLocalAttachmentPickerInterception(): void {
    document.addEventListener("click", handleLocalAttachmentPickerClick, true);
  }

  function installSettingsShellObserver(): void {
    syncSettingsShellPresence();

    if (settingsShellObserver || typeof MutationObserver !== "function") {
      return;
    }

    const target = document.body ?? document.documentElement;
    settingsShellObserver = new MutationObserver(() => {
      syncSettingsShellPresence();
    });
    settingsShellObserver.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  function syncRouteDataset(): void {
    document.documentElement.dataset.pocodexRoute = readCurrentPathname();
  }

  function readCurrentPathname(): string {
    try {
      return new URL(window.location.href).pathname;
    } catch {
      return "/";
    }
  }

  function syncSettingsShellPresence(): void {
    const hasSettingsShell = document.querySelector('nav[aria-label="Settings"]') !== null;
    if (hasSettingsShell) {
      document.documentElement.dataset.pocodexSettingsShell = "true";
    } else {
      delete document.documentElement.dataset.pocodexSettingsShell;
    }
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
    if (refreshSidebarModeFromHostState()) {
      hasRestoredSidebarMode = false;
    }
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

    const className =
      typeof (contentPane as Element & { className?: string }).className === "string"
        ? ((contentPane as Element & { className?: string }).className ?? "").trim()
        : "";
    if (className.includes("left-token-sidebar")) {
      return true;
    }
    if (className.split(/\s+/).includes("left-0")) {
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

  function getSidebarModeStorage() {
    return getStorage("localStorage");
  }

  function getSidebarModePersistedAtomKey(): string {
    return LEGACY_SIDEBAR_MODE_PERSISTED_ATOM_KEY;
  }

  function readSidebarModeFromHostState(state: Record<string, unknown>): SidebarMode | null {
    return readSidebarModeValue(state[LEGACY_SIDEBAR_MODE_PERSISTED_ATOM_KEY]);
  }

  function readSidebarModeFromBrowserStorage(): SidebarMode | null {
    const storage = getSidebarModeStorage();
    if (!storage) {
      return null;
    }

    return readSidebarModeValue(storage.getItem(getSidebarModePersistedAtomKey()));
  }

  function refreshSidebarModeFromHostState(): boolean {
    const nextMode = readSidebarModeFromBrowserStorage();
    if (nextMode === sidebarModeFromHost) {
      return false;
    }

    sidebarModeFromHost = nextMode;
    clearPendingSidebarModeTarget();
    return true;
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
    const storage = getSidebarModeStorage();
    storage?.setItem(getSidebarModePersistedAtomKey(), mode);
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

  function openWorkspaceRootDialog(mode: WorkspaceRootDialogMode): void {
    ensureHostAttached(importHost);
    importHost.hidden = false;
    importHost.replaceChildren();

    const backdrop = document.createElement("div");
    backdrop.dataset.pocodexImportBackdrop = "true";

    const dialog = document.createElement("section");
    dialog.dataset.pocodexImportDialog = "true";

    const header = document.createElement("div");
    header.dataset.pocodexImportHeader = "true";

    const title = document.createElement("h2");
    title.textContent = mode === "pick" ? "Open project folder" : "Add project folder";

    const subtitle = document.createElement("p");
    subtitle.textContent =
      mode === "pick"
        ? "Browse the host filesystem and open the current folder in Pocodex."
        : "Browse the host filesystem and add the current folder as another project in Pocodex.";

    header.append(title, subtitle);

    const browserShell = document.createElement("div");
    browserShell.dataset.pocodexWorkspaceBrowser = "true";

    const sidebar = document.createElement("aside");
    sidebar.dataset.pocodexWorkspaceSidebar = "true";

    const sidebarTitle = document.createElement("p");
    sidebarTitle.dataset.pocodexWorkspaceSidebarTitle = "true";
    sidebarTitle.textContent = "Folder tree";

    const tree = document.createElement("ul");
    tree.dataset.pocodexWorkspaceTree = "true";

    sidebar.append(sidebarTitle, tree);

    const mainPanel = document.createElement("section");
    mainPanel.dataset.pocodexWorkspaceMain = "true";

    const mobileLocation = document.createElement("div");
    mobileLocation.dataset.pocodexWorkspaceMobileLocation = "true";

    const mobileLocationSummary = document.createElement("div");
    mobileLocationSummary.dataset.pocodexWorkspaceMobileLocationSummary = "true";

    const mobileLocationName = document.createElement("strong");
    mobileLocationName.dataset.pocodexWorkspaceMobileLocationName = "true";

    const mobileLocationToggle = document.createElement("button");
    mobileLocationToggle.type = "button";
    mobileLocationToggle.dataset.pocodexWorkspaceMobileToggle = "true";

    mobileLocationSummary.append(mobileLocationName, mobileLocationToggle);

    const mobileLocationPath = document.createElement("div");
    mobileLocationPath.dataset.pocodexWorkspaceMobilePath = "true";

    const mobileLocationPathValue = document.createElement("code");

    const mobileLocationPathNav = document.createElement("div");
    mobileLocationPathNav.dataset.pocodexWorkspaceMobilePathNav = "true";

    const mobileUpButton = document.createElement("button");
    mobileUpButton.type = "button";
    mobileUpButton.dataset.pocodexWorkspaceNavButton = "true";
    mobileUpButton.textContent = "Up";

    const mobileBreadcrumb = document.createElement("nav");
    mobileBreadcrumb.dataset.pocodexWorkspaceBreadcrumb = "true";

    mobileLocationPathNav.append(mobileUpButton, mobileBreadcrumb);
    mobileLocationPath.append(mobileLocationPathValue, mobileLocationPathNav);
    mobileLocation.append(mobileLocationSummary, mobileLocationPath);

    const toolbar = document.createElement("div");
    toolbar.dataset.pocodexWorkspaceToolbar = "true";

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.dataset.pocodexWorkspaceNavButton = "true";
    upButton.textContent = "Up";

    const breadcrumb = document.createElement("nav");
    breadcrumb.dataset.pocodexWorkspaceBreadcrumb = "true";

    toolbar.append(upButton, breadcrumb);

    const currentFolder = document.createElement("div");
    currentFolder.dataset.pocodexWorkspaceCurrent = "true";

    const currentFolderLabel = document.createElement("span");
    currentFolderLabel.textContent = "Current folder";

    const currentFolderPath = document.createElement("code");

    currentFolder.append(currentFolderLabel, currentFolderPath);

    const listHeader = document.createElement("div");
    listHeader.dataset.pocodexWorkspaceListHeader = "true";

    const listTitle = document.createElement("strong");
    listTitle.textContent = "Folders";

    const listMeta = document.createElement("span");

    listHeader.append(listTitle, listMeta);

    const listBody = document.createElement("div");
    listBody.dataset.pocodexWorkspaceList = "true";

    const status = document.createElement("p");
    status.dataset.pocodexWorkspaceStatus = "true";

    mainPanel.append(toolbar, currentFolder, listHeader, listBody, status);
    browserShell.append(sidebar, mainPanel);

    const actions = document.createElement("div");
    actions.dataset.pocodexImportActions = "true";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
      closeImportOverlay();
    });

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.dataset.variant = "primary";
    confirmButton.textContent = mode === "pick" ? "Open this folder" : "Add this folder";

    const directoryCache = new Map<string, WorkspaceRootBrowserResult>();
    const expandedRoots = new Set<string>();
    let treeRoot = "";
    let currentRoot = "";
    let homeDir = "";
    let loadingRoot = "";
    let isMobilePathExpanded = false;
    let isLoading = false;
    let loadError = "";

    const render = () => {
      const currentDirectory = currentRoot ? (directoryCache.get(currentRoot) ?? null) : null;
      const currentFolderLabel = getWorkspaceRootDisplayName(currentRoot, homeDir);
      currentFolderPath.textContent = currentRoot
        ? formatDesktopImportPath(currentRoot)
        : "Loading...";
      mobileLocationName.textContent = currentFolderLabel;
      mobileLocationPathValue.textContent = currentRoot
        ? formatDesktopImportPath(currentRoot)
        : "Loading...";
      mobileLocationToggle.textContent = isMobilePathExpanded ? "▴" : "▾";
      mobileLocationToggle.disabled = currentRoot.length === 0;
      mobileLocationToggle.setAttribute("aria-expanded", String(isMobilePathExpanded));
      mobileLocationToggle.setAttribute(
        "aria-label",
        isMobilePathExpanded ? "Hide full path navigation" : "Show full path navigation",
      );
      mobileLocationPath.hidden = !isMobilePathExpanded;
      confirmButton.disabled = isLoading || currentRoot.length === 0;
      upButton.disabled = isLoading || !currentDirectory?.parentRoot;
      mobileUpButton.disabled = upButton.disabled;
      listMeta.textContent =
        currentDirectory && currentDirectory.entries.length > 0
          ? `${currentDirectory.entries.length} folders`
          : "";

      renderWorkspaceRootBreadcrumbs(breadcrumb, currentRoot, homeDir, (root) => {
        void openDirectory(root);
      });
      renderWorkspaceRootBreadcrumbs(mobileBreadcrumb, currentRoot, homeDir, (root) => {
        void openDirectory(root);
        isMobilePathExpanded = false;
        render();
      });
      renderWorkspaceRootTree(tree, {
        treeRoot,
        currentRoot,
        homeDir,
        directoryCache,
        expandedRoots,
        onOpen(root) {
          void openDirectory(root);
        },
      });

      listBody.replaceChildren();
      status.hidden = true;
      status.textContent = "";

      if (loadError) {
        status.hidden = false;
        status.textContent = loadError;
        return;
      }

      if (isLoading && (!currentDirectory || loadingRoot === currentRoot)) {
        status.hidden = false;
        status.textContent = "Loading folders...";
        return;
      }

      if (!currentDirectory) {
        return;
      }

      if (currentDirectory.entries.length === 0) {
        status.hidden = false;
        status.textContent = "No folders are available here.";
        return;
      }

      for (const entry of currentDirectory.entries) {
        const row = document.createElement("button");
        row.type = "button";
        row.dataset.pocodexWorkspaceEntry = "true";

        const entryName = document.createElement("strong");
        entryName.textContent = entry.name;

        const entryPath = document.createElement("span");
        entryPath.textContent = formatDesktopImportPath(entry.path);

        row.append(entryName, entryPath);
        row.addEventListener("click", () => {
          void openDirectory(entry.path);
        });
        listBody.appendChild(row);
      }
    };

    const openDirectory = async (root?: string): Promise<void> => {
      isLoading = true;
      loadError = "";
      loadingRoot = root ?? "";
      render();

      try {
        const result = await listWorkspaceRootBrowserFromHost(root);
        directoryCache.set(result.root, result);
        currentRoot = result.root;
        homeDir = result.homeDir;
        expandedRoots.add(result.root);
        if (!treeRoot || !isWorkspaceRootPathWithin(treeRoot, result.root)) {
          treeRoot = result.root;
        }
        isLoading = false;
        loadingRoot = "";
        render();
      } catch (error) {
        isLoading = false;
        loadingRoot = "";
        loadError =
          error instanceof Error
            ? error.message
            : "Failed to load folders from the host filesystem.";
        render();
      }
    };

    const submit = async () => {
      if (!currentRoot) {
        return;
      }

      confirmButton.disabled = true;
      cancelButton.disabled = true;
      confirmButton.textContent = mode === "pick" ? "Opening..." : "Adding...";

      try {
        const result = await addWorkspaceRootFromHost({
          root: currentRoot,
          setActive: mode === "pick",
        });
        if (!result.success) {
          throw new Error(result.error || "Failed to add project from the host filesystem.");
        }

        closeImportOverlay();
        dispatchHostMessage({
          type: mode === "pick" ? "workspace-root-option-picked" : "workspace-root-option-added",
          root: result.root,
        });
        showNotice(
          mode === "pick"
            ? "Opened project from the host filesystem."
            : "Added project from the host filesystem.",
        );
      } catch (error) {
        confirmButton.textContent = mode === "pick" ? "Open this folder" : "Add this folder";
        cancelButton.disabled = false;
        confirmButton.disabled = currentRoot.length === 0;
        showNotice(
          error instanceof Error
            ? error.message
            : "Failed to add project from the host filesystem.",
        );
      }
    };

    upButton.addEventListener("click", () => {
      const currentDirectory = currentRoot ? (directoryCache.get(currentRoot) ?? null) : null;
      if (currentDirectory?.parentRoot) {
        void openDirectory(currentDirectory.parentRoot);
      }
    });
    mobileUpButton.addEventListener("click", () => {
      const currentDirectory = currentRoot ? (directoryCache.get(currentRoot) ?? null) : null;
      if (currentDirectory?.parentRoot) {
        isMobilePathExpanded = false;
        void openDirectory(currentDirectory.parentRoot);
      }
    });
    mobileLocationToggle.addEventListener("click", () => {
      if (!currentRoot) {
        return;
      }
      isMobilePathExpanded = !isMobilePathExpanded;
      render();
    });
    confirmButton.addEventListener("click", () => {
      void submit();
    });

    actions.append(cancelButton, confirmButton);
    mainPanel.prepend(mobileLocation);
    dialog.append(header, browserShell, actions);
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target !== backdrop) {
        return;
      }
      closeImportOverlay();
    });

    importHost.appendChild(backdrop);
    render();
    void openDirectory();
  }

  function formatDesktopImportPath(path: string): string {
    const trimmedPath = path.trim();
    if (trimmedPath.length === 0) {
      return path;
    }

    return trimmedPath.replace(/^\/(?:users|home)\/[^/]+(?=\/|$)/i, "~");
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

  function closeImportOverlay(): void {
    importHost.hidden = true;
    importHost.replaceChildren();
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

  async function addWorkspaceRootFromHost(params: {
    root: string;
    setActive: boolean;
  }): Promise<WorkspaceRootAddResult> {
    const result = await callPocodexIpc("workspace-root-option/add", params);
    if (!isWorkspaceRootAddResult(result)) {
      throw new Error("Pocodex returned an invalid workspace-root response.");
    }
    return result;
  }

  async function listWorkspaceRootBrowserFromHost(
    root?: string,
  ): Promise<WorkspaceRootBrowserResult> {
    const result = await callPocodexIpc("workspace-root-browser/list", root ? { root } : undefined);
    if (!isWorkspaceRootBrowserResult(result)) {
      throw new Error("Pocodex returned an invalid workspace-root browser response.");
    }
    return result;
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

  function isWorkspaceRootAddResult(value: unknown): value is WorkspaceRootAddResult {
    return (
      isRecord(value) &&
      typeof value.success === "boolean" &&
      typeof value.root === "string" &&
      (value.error === undefined || typeof value.error === "string")
    );
  }

  function isWorkspaceRootBrowserResult(value: unknown): value is WorkspaceRootBrowserResult {
    return (
      isRecord(value) &&
      typeof value.root === "string" &&
      (value.parentRoot === null || typeof value.parentRoot === "string") &&
      typeof value.homeDir === "string" &&
      Array.isArray(value.entries) &&
      value.entries.every(
        (entry) =>
          isRecord(entry) && typeof entry.name === "string" && typeof entry.path === "string",
      )
    );
  }

  function getWorkspaceRootDisplayName(root: string, homeDir: string): string {
    if (!root) {
      return "Loading...";
    }

    const normalizedRoot = normalizeWorkspaceRootBrowserPath(root);
    if (normalizedRoot === "/") {
      return "/";
    }
    if (normalizedRoot === homeDir) {
      return "~";
    }

    const parts = normalizedRoot.split("/").filter((part) => part.length > 0);
    return parts.at(-1) ?? normalizedRoot;
  }

  function renderWorkspaceRootBreadcrumbs(
    host: HTMLElement,
    currentRoot: string,
    homeDir: string,
    onOpen: (root: string) => void,
  ): void {
    host.replaceChildren();
    if (!currentRoot) {
      return;
    }

    const segments = getWorkspaceRootPathSegments(currentRoot, homeDir);
    for (const segment of segments) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = segment.label;
      button.addEventListener("click", () => {
        onOpen(segment.path);
      });
      host.appendChild(button);
    }
  }

  function getWorkspaceRootPathSegments(
    root: string,
    homeDir: string,
  ): Array<{ label: string; path: string }> {
    const normalized = normalizeWorkspaceRootBrowserPath(root);
    if (normalized === "/") {
      return [{ label: "/", path: "/" }];
    }

    const parts = normalized.split("/").filter((part) => part.length > 0);
    const segments: Array<{ label: string; path: string }> = [];
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      segments.push({
        label: current === homeDir ? "~" : part,
        path: current,
      });
    }
    return segments;
  }

  function renderWorkspaceRootTree(
    host: HTMLElement,
    options: {
      treeRoot: string;
      currentRoot: string;
      homeDir: string;
      directoryCache: Map<string, WorkspaceRootBrowserResult>;
      expandedRoots: Set<string>;
      onOpen: (root: string) => void;
    },
  ): void {
    host.replaceChildren();
    if (!options.treeRoot) {
      return;
    }

    host.appendChild(
      createWorkspaceRootTreeItem(options.treeRoot, {
        currentRoot: options.currentRoot,
        homeDir: options.homeDir,
        directoryCache: options.directoryCache,
        expandedRoots: options.expandedRoots,
        onOpen: options.onOpen,
      }),
    );
  }

  function createWorkspaceRootTreeItem(
    root: string,
    options: {
      currentRoot: string;
      homeDir: string;
      directoryCache: Map<string, WorkspaceRootBrowserResult>;
      expandedRoots: Set<string>;
      onOpen: (root: string) => void;
    },
  ): HTMLLIElement {
    const item = document.createElement("li");
    item.dataset.pocodexWorkspaceTreeItem = "true";

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.pocodexWorkspaceTreeButton = "true";
    if (root === options.currentRoot) {
      button.dataset.current = "true";
    }

    const isExpanded = options.expandedRoots.has(root);
    const currentDirectory = options.directoryCache.get(root);

    const caret = document.createElement("span");
    caret.dataset.pocodexWorkspaceTreeCaret = "true";
    caret.textContent = isExpanded && currentDirectory ? "▾" : "▸";

    const label = document.createElement("span");
    label.textContent = getWorkspaceRootTreeLabel(root, options.homeDir);

    button.append(caret, label);
    button.addEventListener("click", () => {
      options.expandedRoots.add(root);
      options.onOpen(root);
    });

    item.appendChild(button);

    if (isExpanded && currentDirectory && currentDirectory.entries.length > 0) {
      const subtree = document.createElement("ul");
      subtree.dataset.pocodexWorkspaceTree = "true";
      for (const entry of currentDirectory.entries) {
        if (
          !options.expandedRoots.has(entry.path) &&
          entry.path !== options.currentRoot &&
          !isWorkspaceRootPathWithin(entry.path, options.currentRoot)
        ) {
          continue;
        }
        subtree.appendChild(
          createWorkspaceRootTreeItem(entry.path, {
            currentRoot: options.currentRoot,
            homeDir: options.homeDir,
            directoryCache: options.directoryCache,
            expandedRoots: options.expandedRoots,
            onOpen: options.onOpen,
          }),
        );
      }
      if (subtree.childNodes.length > 0) {
        item.appendChild(subtree);
      }
    }

    return item;
  }

  function getWorkspaceRootTreeLabel(root: string, homeDir: string): string {
    if (root === homeDir) {
      return "~";
    }

    const normalized = normalizeWorkspaceRootBrowserPath(root);
    if (normalized === "/") {
      return "/";
    }

    const parts = normalized.split("/").filter((part) => part.length > 0);
    return parts.at(-1) ?? normalized;
  }

  function isWorkspaceRootPathWithin(parent: string, child: string): boolean {
    const normalizedParent = normalizeWorkspaceRootBrowserPath(parent);
    const normalizedChild = normalizeWorkspaceRootBrowserPath(child);
    if (normalizedParent === "/") {
      return normalizedChild.startsWith("/");
    }
    return (
      normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
    );
  }

  function normalizeWorkspaceRootBrowserPath(path: string): string {
    if (!path) {
      return "/";
    }

    return path.length > 1 ? path.replace(/\/+$/, "") : path;
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
      hasReceivedSidebarModeSync = true;
      if (readSidebarModeFromBrowserStorage() === null) {
        const state = isRecord(message.state) ? message.state : {};
        const migratedMode = readSidebarModeFromHostState(state);
        if (migratedMode) {
          const storage = getSidebarModeStorage();
          storage?.setItem(getSidebarModePersistedAtomKey(), migratedMode);
        }
        if (refreshSidebarModeFromHostState()) {
          hasRestoredSidebarMode = false;
          scheduleSidebarModeReconcile(20);
        }
      }
    }
  }

  function installEnterBehaviorOverrideObservers(): void {
    if (isEnterBehaviorOverrideObserverStarted) {
      return;
    }

    isEnterBehaviorOverrideObserverStarted = true;
    document.addEventListener("focusin", refreshEffectiveEnterBehavior, true);
    document.addEventListener("focusout", refreshEffectiveEnterBehavior, true);
    window.addEventListener("resize", refreshEffectiveEnterBehavior);
    window.visualViewport?.addEventListener("resize", refreshEffectiveEnterBehavior);
  }

  function rewriteBridgeMessageForLocalOverrides(message: unknown): unknown {
    rememberHostEnterBehavior(message);

    if (!isRecord(message) || typeof message.type !== "string") {
      return message;
    }

    const overriddenMessage = overrideEnterBehaviorInMessage(message);
    rememberDispatchedEnterBehavior(overriddenMessage);
    syncSidebarModeWithBridgeMessage(overriddenMessage);
    if (isRecord(overriddenMessage)) {
      rememberSharedObjectSnapshot(overriddenMessage);
    }
    syncThreadQueryWithBridgeMessage(overriddenMessage);
    syncRestorableTerminalAttachments(overriddenMessage, "incoming");
    return overriddenMessage;
  }

  function rememberSharedObjectSnapshot(message: Record<string, unknown>): void {
    if (message.type !== "shared-object-updated" || typeof message.key !== "string") {
      return;
    }

    sharedObjectSnapshots.set(message.key, message.value ?? null);
  }

  function overrideEnterBehaviorInMessage(message: Record<string, unknown>): unknown {
    if (!shouldForceNewlineEnterBehavior()) {
      return message;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? { ...message.state } : {};
      state[ENTER_BEHAVIOR_ATOM_KEY] = ENTER_BEHAVIOR_NEWLINE;
      return {
        ...message,
        state,
      };
    }

    if (message.type === "persisted-atom-updated" && message.key === ENTER_BEHAVIOR_ATOM_KEY) {
      return {
        ...message,
        value: ENTER_BEHAVIOR_NEWLINE,
        deleted: false,
      };
    }

    return message;
  }

  function rememberHostEnterBehavior(message: unknown): void {
    const state = getEnterBehaviorStateFromMessage(message);
    if (!state) {
      return;
    }

    hasSeenHostEnterBehavior = true;
    hostEnterBehaviorDeleted = state.deleted;
    hostEnterBehaviorValue = state.value;
  }

  function rememberDispatchedEnterBehavior(message: unknown): void {
    const state = getEnterBehaviorStateFromMessage(message);
    if (!state) {
      return;
    }

    hasDispatchedEnterBehavior = true;
    dispatchedEnterBehaviorDeleted = state.deleted;
    dispatchedEnterBehaviorValue = state.value;
  }

  function getEnterBehaviorStateFromMessage(
    message: unknown,
  ): { deleted: boolean; value: unknown } | null {
    if (!isRecord(message) || typeof message.type !== "string") {
      return null;
    }

    if (message.type === "persisted-atom-sync") {
      const state = isRecord(message.state) ? message.state : null;
      if (state && Object.prototype.hasOwnProperty.call(state, ENTER_BEHAVIOR_ATOM_KEY)) {
        return {
          deleted: false,
          value: state[ENTER_BEHAVIOR_ATOM_KEY],
        };
      }

      return {
        deleted: true,
        value: undefined,
      };
    }

    if (
      message.type === "persisted-atom-updated" &&
      typeof message.key === "string" &&
      message.key === ENTER_BEHAVIOR_ATOM_KEY
    ) {
      return {
        deleted: message.deleted === true,
        value: message.value,
      };
    }

    return null;
  }

  function refreshEffectiveEnterBehavior(): void {
    if (!hasSeenHostEnterBehavior) {
      return;
    }

    const next = getEffectiveEnterBehaviorState();
    if (
      hasDispatchedEnterBehavior &&
      dispatchedEnterBehaviorDeleted === next.deleted &&
      Object.is(dispatchedEnterBehaviorValue, next.value)
    ) {
      return;
    }

    hasDispatchedEnterBehavior = true;
    dispatchedEnterBehaviorDeleted = next.deleted;
    dispatchedEnterBehaviorValue = next.value;
    dispatchHostMessage({
      type: "persisted-atom-updated",
      key: ENTER_BEHAVIOR_ATOM_KEY,
      value: next.value,
      deleted: next.deleted,
    });
  }

  function getEffectiveEnterBehaviorState(): { deleted: boolean; value: unknown } {
    if (shouldForceNewlineEnterBehavior()) {
      return {
        deleted: false,
        value: ENTER_BEHAVIOR_NEWLINE,
      };
    }

    return {
      deleted: hostEnterBehaviorDeleted,
      value: hostEnterBehaviorValue,
    };
  }

  function shouldForceNewlineEnterBehavior(): boolean {
    if (!isTextEntryFocused()) {
      return false;
    }

    const keyboardInset = getSoftKeyboardViewportInset();
    if (keyboardInset !== null) {
      return keyboardInset >= SOFT_KEYBOARD_INSET_THRESHOLD_PX;
    }

    return supportsTouchInput();
  }

  function getSoftKeyboardViewportInset(): number | null {
    const visualViewport = window.visualViewport;
    if (!visualViewport || typeof visualViewport.height !== "number") {
      return null;
    }

    const layoutViewportHeight = typeof window.innerHeight === "number" ? window.innerHeight : 0;
    if (layoutViewportHeight <= 0) {
      return null;
    }

    return Math.max(0, layoutViewportHeight - visualViewport.height);
  }

  function supportsTouchInput(): boolean {
    if (typeof navigator !== "undefined" && typeof navigator.maxTouchPoints === "number") {
      if (navigator.maxTouchPoints > 0) {
        return true;
      }
    }

    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(pointer: coarse)").matches;
    }

    return false;
  }

  function isTextEntryFocused(): boolean {
    const activeElement = document.activeElement;
    return activeElement instanceof Element && isTextEntryElement(activeElement);
  }

  function isTextEntryElement(element: Element): boolean {
    if (element.tagName === "TEXTAREA") {
      return true;
    }

    const contentEditable = element.getAttribute("contenteditable");
    if (contentEditable === "" || contentEditable === "true") {
      return true;
    }

    if (element.tagName !== "INPUT") {
      return false;
    }

    const inputType = element.getAttribute("type")?.trim().toLowerCase() ?? "text";
    return !NON_TEXT_INPUT_TYPES.has(inputType);
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

    if (message.type === "pocodex-open-workspace-root-dialog") {
      const mode = message.mode === "pick" ? "pick" : "add";
      openWorkspaceRootDialog(mode);
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

  function readPositiveInteger(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return null;
    }

    return value;
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

  function syncRestorableTerminalAttachments(
    message: unknown,
    direction: "incoming" | "outgoing",
  ): void {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "terminal-create":
      case "terminal-attach":
        if (direction === "outgoing") {
          rememberRestorableTerminalAttachment(message);
        }
        return;
      case "terminal-resize":
        if (direction === "outgoing") {
          rememberRestorableTerminalResize(message);
        }
        return;
      case "terminal-close":
        if (direction === "outgoing") {
          forgetRestorableTerminalAttachment(message);
        }
        return;
      case "terminal-attached":
        if (direction === "incoming") {
          rememberRestorableTerminalCwd(message);
        }
        return;
      case "terminal-exit":
        if (direction === "incoming") {
          forgetRestorableTerminalAttachment(message);
        }
        return;
      default:
        return;
    }
  }

  function rememberRestorableTerminalAttachment(message: Record<string, unknown>): void {
    const sessionId = readNonEmptyString(message.sessionId);
    if (!sessionId) {
      return;
    }

    const existing = restorableTerminalAttachments.get(sessionId);
    restorableTerminalAttachments.set(sessionId, {
      sessionId,
      conversationId:
        readNonEmptyString(message.conversationId) ?? existing?.conversationId ?? null,
      cwd: readNonEmptyString(message.cwd) ?? existing?.cwd ?? null,
      cols: readPositiveInteger(message.cols) ?? existing?.cols ?? null,
      rows: readPositiveInteger(message.rows) ?? existing?.rows ?? null,
      forceCwdSync: message.forceCwdSync === true || existing?.forceCwdSync === true,
    });
  }

  function rememberRestorableTerminalResize(message: Record<string, unknown>): void {
    const sessionId = readNonEmptyString(message.sessionId);
    if (!sessionId) {
      return;
    }

    const existing = restorableTerminalAttachments.get(sessionId);
    if (!existing) {
      return;
    }

    const cols = readPositiveInteger(message.cols);
    const rows = readPositiveInteger(message.rows);
    if (cols === null || rows === null) {
      return;
    }

    restorableTerminalAttachments.set(sessionId, {
      ...existing,
      cols,
      rows,
    });
  }

  function rememberRestorableTerminalCwd(message: Record<string, unknown>): void {
    const sessionId = readNonEmptyString(message.sessionId);
    if (!sessionId) {
      return;
    }

    const existing = restorableTerminalAttachments.get(sessionId);
    const cwd = readNonEmptyString(message.cwd);
    if (!existing || !cwd) {
      return;
    }

    restorableTerminalAttachments.set(sessionId, {
      ...existing,
      cwd,
    });
  }

  function forgetRestorableTerminalAttachment(message: Record<string, unknown>): void {
    const sessionId = readNonEmptyString(message.sessionId);
    if (sessionId) {
      restorableTerminalAttachments.delete(sessionId);
    }
  }

  function replayRestorableTerminalAttachments(): void {
    for (const attachment of restorableTerminalAttachments.values()) {
      const message: Record<string, unknown> = {
        type: "terminal-attach",
        sessionId: attachment.sessionId,
      };

      if (attachment.conversationId) {
        message.conversationId = attachment.conversationId;
      }
      if (attachment.cwd) {
        message.cwd = attachment.cwd;
      }
      if (attachment.cols !== null) {
        message.cols = attachment.cols;
      }
      if (attachment.rows !== null) {
        message.rows = attachment.rows;
      }
      if (attachment.forceCwdSync) {
        message.forceCwdSync = true;
      }

      sendEnvelope({
        type: "bridge_message",
        message,
      });
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
    scheduleThreadRestore(conversationId);
  }

  function scheduleThreadRestoreFromUrl(): void {
    const conversationId = readThreadQueryConversationId();
    if (!conversationId) {
      return;
    }

    scheduleThreadRestore(conversationId);
  }

  function scheduleThreadRestore(conversationId: string): void {
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

  function replayHostBootstrapAfterReconnect(): void {
    sendEnvelope({
      type: "bridge_message",
      message: {
        type: "ready",
      },
    });
    scheduleThreadRestoreFromUrl();
    replayRestorableTerminalAttachments();
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

  function restoreStoredRouteIfNeeded(): void {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.pathname !== "/" && currentUrl.pathname !== "/index.html") {
      return;
    }

    const storedRoute = readSessionStorage(LAST_ROUTE_STORAGE_KEY);
    if (!storedRoute) {
      return;
    }

    try {
      window.history.replaceState(null, "", storedRoute);
    } catch {
      // Ignore history update failures and keep the current route.
    }
  }

  function installRoutePersistence(): void {
    const historyObject = window.history;
    if (!historyObject) {
      return;
    }

    const originalPushState =
      typeof historyObject.pushState === "function"
        ? historyObject.pushState.bind(historyObject)
        : null;
    const originalReplaceState =
      typeof historyObject.replaceState === "function"
        ? historyObject.replaceState.bind(historyObject)
        : null;

    if (originalPushState) {
      historyObject.pushState = (data, unused, url) => {
        originalPushState(data, unused, url);
        persistCurrentRoute();
      };
    }

    if (originalReplaceState) {
      historyObject.replaceState = (data, unused, url) => {
        originalReplaceState(data, unused, url);
        persistCurrentRoute();
      };
    }

    window.addEventListener("popstate", persistCurrentRoute);
    window.addEventListener("hashchange", persistCurrentRoute);
    persistCurrentRoute();
  }

  function persistCurrentRoute(): void {
    writeSessionStorage(LAST_ROUTE_STORAGE_KEY, buildRestorableRoute(window.location.href));
  }

  function buildRestorableRoute(href: string): string {
    const url = new URL(href);
    url.searchParams.delete("token");
    const route = `${url.pathname}${url.search}${url.hash}`;
    return route.length > 0 ? route : "/";
  }

  function readSessionStorage(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSessionStorage(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Ignore storage failures when persistence is unavailable.
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
    pendingManualReconnect = false;
    reconnectAttempt = 0;
    lastServerHeartbeatAt = Date.now();
    setConnectionPhase("connected");
    clearReconnectTimer();
    startHeartbeatMonitor();
  }

  function reconnectNow(): void {
    if (isClosing) {
      return;
    }

    clearReconnectTimer();
    clearHeartbeatMonitor();

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      pendingManualReconnect = true;
      setConnectionPhase("reconnecting", "Reconnecting to Pocodex...", {
        mode: "passive",
      });
      socket.close(4000, "manual-reconnect");
      return;
    }

    scheduleReconnect("Reconnecting to Pocodex...", {
      immediate: true,
      passive: true,
      suppressEscalation: true,
    });
  }

  function reloadCurrentPage(): void {
    window.location.reload();
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
      const isReconnectOpen = hasConnected;
      isConnecting = false;
      hasConnected = true;
      noteHealthyConnection();
      flushPendingMessages();
      publishFocusState();
      for (const workerName of workerSubscribers.keys()) {
        sendEnvelope({ type: "worker_subscribe", workerName });
      }
      if (isReconnectOpen) {
        replayHostBootstrapAfterReconnect();
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
            const bridgeMessage = rewriteBridgeMessageForLocalOverrides(envelope.message);
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
      const isManualReconnect = pendingManualReconnect || event.reason === "manual-reconnect";
      if (isManualReconnect) {
        pendingManualReconnect = false;
      }
      const shouldReconnect = !isClosing;
      socket = null;
      isConnecting = false;
      clearHeartbeatMonitor();
      if (!shouldReconnect) {
        return;
      }
      const message = isManualReconnect
        ? "Reconnecting to Pocodex..."
        : describeReconnectReason(event);
      scheduleReconnect(message, {
        immediate: isManualReconnect,
        passive: true,
        suppressEscalation:
          isManualReconnect || !isDocumentVisible() || !isNetworkOnline() || isWakeGraceActive(),
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
      syncRestorableTerminalAttachments(message, "outgoing");
      sendEnvelope({ type: "bridge_message", message });
      syncThreadQueryWithBridgeMessage(message);
      if (isRecord(message) && message.type === "ready") {
        scheduleInitialThreadRestoreFromUrl();
      }
    },
    getPathForFile: () => null,
    getSharedObjectSnapshotValue: (key) => sharedObjectSnapshots.get(key) ?? null,
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
