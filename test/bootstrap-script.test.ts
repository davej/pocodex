import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { renderBootstrapScript } from "../src/lib/bootstrap-script.js";

type TestListener = (...args: unknown[]) => void;

class TestEventTargetLike {
  private readonly listeners = new Map<string, TestListener[]>();

  addEventListener(type: string, listener: TestListener, _options?: unknown): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: TestListener): void {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }

    const next = existing.filter((candidate) => candidate !== listener);
    if (next.length === 0) {
      this.listeners.delete(type);
      return;
    }

    this.listeners.set(type, next);
  }

  dispatchEvent(event: { type: string }): boolean {
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
    return true;
  }
}

class TestElement extends TestEventTargetLike {
  readonly children: TestElement[] = [];
  readonly dataset: Record<string, string> = {};
  parentElement: TestElement | null = null;
  hidden = false;
  className = "";
  id = "";
  rel = "";
  href = "";
  textContent = "";
  type = "";
  multiple = false;
  value = "";
  placeholder = "";
  disabled = false;
  style: Record<string, string> = {};
  private rectLeft = 0;
  private rectWidth = 0;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {
    super();
  }

  appendChild<T extends TestElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: TestElement[]): void {
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  contains(node: TestElement): boolean {
    let current: TestElement | null = node;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  replaceChildren(...nodes: TestElement[]): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentElement) {
      return;
    }

    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) {
      this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
  }

  after(node: TestElement): void {
    if (!this.parentElement) {
      return;
    }

    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index === -1) {
      return;
    }

    node.parentElement = this.parentElement;
    siblings.splice(index + 1, 0, node);
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") {
      this.id = value;
    }
    if (name === "class") {
      this.className = value;
    }
    if (name === "href") {
      this.href = value;
    }
    if (name === "rel") {
      this.rel = value;
    }
    if (name === "type") {
      this.type = value;
    }
    if (name === "multiple") {
      this.multiple = true;
    }
    if (name.startsWith("data-")) {
      const datasetKey = name
        .slice("data-".length)
        .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      this.dataset[datasetKey] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "id") {
      return this.id || null;
    }
    if (name === "class") {
      return this.className || null;
    }
    if (name === "href") {
      return this.href || null;
    }
    if (name === "rel") {
      return this.rel || null;
    }
    return this.attributes.get(name) ?? null;
  }

  setBoundingClientRect(rect: { left?: number; width?: number }): void {
    if (typeof rect.left === "number") {
      this.rectLeft = rect.left;
    }
    if (typeof rect.width === "number") {
      this.rectWidth = rect.width;
    }
  }

  getBoundingClientRect() {
    return {
      left: this.rectLeft,
      top: 0,
      right: this.rectLeft + this.rectWidth,
      bottom: 0,
      width: this.rectWidth,
      height: 0,
      x: this.rectLeft,
      y: 0,
      toJSON: () => null,
    };
  }

  querySelector(selector: string): TestElement | null {
    for (const child of this.children) {
      if (matchesTestSelector(child, selector)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  querySelectorAll(selector: string) {
    const matches: TestElement[] = [];
    if (selector === ":scope > button") {
      for (const child of this.children) {
        if (matchesTestSelector(child, "button")) {
          matches.push(child);
        }
      }
      return createTestNodeList(matches);
    }

    for (const child of this.children) {
      collectTestMatches(child, selector, matches);
    }
    return createTestNodeList(matches);
  }

  closest(selector: string): TestElement | null {
    if (matchesTestSelector(this, selector)) {
      return this;
    }

    return this.parentElement?.closest(selector) ?? null;
  }
}

class TestHTMLDivElement extends TestElement {
  constructor() {
    super("DIV");
  }
}

class TestHTMLLinkElement extends TestElement {
  constructor() {
    super("LINK");
  }
}

class TestDocument extends TestEventTargetLike {
  readyState = "complete";
  visibilityState = "visible";
  documentElement = new TestElement("HTML");
  head = new TestElement("HEAD");
  body = new TestElement("BODY");

  constructor() {
    super();
    this.documentElement.append(this.head, this.body);
  }

  createElement(tagName: string): TestElement {
    switch (tagName.toLowerCase()) {
      case "div":
        return new TestHTMLDivElement();
      case "link":
        return new TestHTMLLinkElement();
      default:
        return new TestElement(tagName.toUpperCase());
    }
  }

  querySelector(selector: string): TestElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string) {
    return this.documentElement.querySelectorAll(selector);
  }

  getElementsByTagName(tagName: string): TestElement[] {
    return tagName === "head" ? [this.head] : [];
  }

  getElementById(id: string): TestElement | null {
    return findTestById(this.documentElement, id);
  }

  hasFocus(): boolean {
    return true;
  }
}

class TestMutationObserver {
  constructor(_callback: (...args: unknown[]) => void) {}

  observe(_target: TestElement, _options: unknown): void {}
}

class TestRequest {
  method = "GET";

  constructor(readonly url: string) {}
}

class TestResponse {
  constructor(
    readonly body: string,
    readonly init: {
      status: number;
      headers: Record<string, string>;
    },
  ) {}

  get ok(): boolean {
    return this.init.status >= 200 && this.init.status < 300;
  }

  get status(): number {
    return this.init.status;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }

  async text(): Promise<string> {
    return this.body;
  }
}

class TestMessageEvent {
  constructor(
    readonly type: string,
    readonly init: { data: unknown },
  ) {}
}

class TestMouseEvent {
  readonly button: number;
  readonly target: TestElement;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;

  constructor(
    readonly type: string,
    options: {
      button?: number;
      target: TestElement;
      metaKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
    },
  ) {
    this.button = options.button ?? 0;
    this.target = options.target;
    this.metaKey = options.metaKey ?? false;
    this.ctrlKey = options.ctrlKey ?? false;
    this.altKey = options.altKey ?? false;
    this.shiftKey = options.shiftKey ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static latest: TestWebSocket | null = null;

  readonly listeners = new Map<string, TestListener[]>();
  readonly sentMessages: string[] = [];
  readyState = TestWebSocket.CONNECTING;

  constructor(readonly url: string) {
    TestWebSocket.latest = this;
  }

  addEventListener(type: string, listener: TestListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(message: string): void {
    this.sentMessages.push(message);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = TestWebSocket.CLOSED;
  }

  emit(type: string, event: unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function createTestNodeList(matches: TestElement[]) {
  return {
    length: matches.length,
    item(index: number): TestElement | null {
      return matches[index] ?? null;
    },
    forEach(callback: (value: TestElement, key: number, parent: unknown) => void): void {
      matches.forEach((value, index) => callback(value, index, matches));
    },
  };
}

function collectTestMatches(element: TestElement, selector: string, matches: TestElement[]): void {
  if (matchesTestSelector(element, selector)) {
    matches.push(element);
  }
  for (const child of element.children) {
    collectTestMatches(child, selector, matches);
  }
}

function findTestById(element: TestElement, id: string): TestElement | null {
  if (element.id === id) {
    return element;
  }
  for (const child of element.children) {
    const match = findTestById(child, id);
    if (match) {
      return match;
    }
  }
  return null;
}

function matchesTestSelector(element: TestElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .some((part) => matchesSingleTestSelector(element, part));
}

function matchesSingleTestSelector(element: TestElement, selector: string): boolean {
  if (selector.startsWith(".")) {
    return element.className
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .includes(selector.slice(1));
  }

  const attributeMatch = /^(?:(\w+))?\[([a-zA-Z0-9_-]+)(?:=['"]([^'"]+)['"])?\]$/.exec(selector);
  if (attributeMatch) {
    const [, tagName, attributeName, attributeValue] = attributeMatch;
    const actualAttributeValue = readTestAttribute(element, attributeName);
    return (
      (tagName === undefined || element.tagName === tagName.toUpperCase()) &&
      (attributeValue === undefined
        ? actualAttributeValue !== null
        : actualAttributeValue === attributeValue)
    );
  }

  return element.tagName === selector.toUpperCase();
}

function readTestAttribute(element: TestElement, name: string): string | null {
  if (name.startsWith("data-")) {
    const datasetKey = name
      .slice("data-".length)
      .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    return element.dataset[datasetKey] ?? element.getAttribute(name);
  }

  return element.getAttribute(name);
}

function drainTestTimers(pendingTimers: Map<number, () => void>, maxRuns = 20): void {
  for (let index = 0; index < maxRuns; index += 1) {
    const next = pendingTimers.entries().next().value as [number, () => void] | undefined;
    if (!next) {
      return;
    }

    const [timerId, callback] = next;
    pendingTimers.delete(timerId);
    callback();
  }
}

async function flushBootstrapMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createBootstrapJsonResponse(body: unknown, status = 200): TestResponse {
  return new TestResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function readBootstrapFetchBody(fetchCall: { input: unknown; init: unknown } | undefined): string {
  if (
    !fetchCall ||
    typeof fetchCall.init !== "object" ||
    fetchCall.init === null ||
    !("body" in fetchCall.init) ||
    typeof (fetchCall.init as { body?: unknown }).body !== "string"
  ) {
    return "";
  }

  return (fetchCall.init as { body: string }).body;
}

function setMobileSidebarOpenState(contentPane: TestElement, navigation?: TestElement): void {
  contentPane.style.width = "calc(100% - var(--spacing-token-sidebar))";
  contentPane.style.transform = "translateX(var(--spacing-token-sidebar))";
  contentPane.setBoundingClientRect({ left: 240, width: 150 });
  navigation?.setBoundingClientRect({ left: 0, width: 240 });
}

function setMobileSidebarClosedState(contentPane: TestElement, navigation?: TestElement): void {
  contentPane.style.width = "100%";
  contentPane.style.transform = "translateX(0)";
  contentPane.setBoundingClientRect({ left: 0, width: 390 });
  navigation?.setBoundingClientRect({ left: -240, width: 240 });
}

function createBootstrapHarness(
  options: {
    href?: string;
    localStorageEntries?: Record<string, string>;
    mobile?: boolean;
  } = {},
) {
  const href = options.href ?? "http://127.0.0.1:8787/?token=secret";
  const localStorageEntries = new Map<string, string>(
    Object.entries(options.localStorageEntries ?? {}),
  );
  const sessionStorageEntries = new Map<string, string>();
  const serviceWorkerRegistrations: Array<{
    scriptUrl: string;
    options?: { scope?: string; updateViaCache?: "all" | "imports" | "none" };
  }> = [];
  const timers = new Map<number, () => void>();
  const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
  const dispatchedMessages: unknown[] = [];
  const replaceStateCalls: Array<string | URL | null | undefined> = [];
  let nextTimerId = 1;
  let fetchImplementation: (input: unknown, init?: unknown) => Promise<TestResponse> = async () =>
    new TestResponse(
      JSON.stringify({
        resultType: "success",
        result: {},
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  TestWebSocket.latest = null;

  const document = new TestDocument();
  const windowObject = new TestEventTargetLike() as TestEventTargetLike & {
    location: {
      href: string;
      protocol: string;
      host: string;
      reload: () => void;
    };
    history: {
      pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
      replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
    };
    fetch: (input: unknown, init?: unknown) => Promise<unknown>;
    setTimeout: (callback: () => void, delay: number) => number;
    clearTimeout: (id: number) => void;
    matchMedia: (query: string) => { matches: boolean; media: string };
    navigator: {
      onLine: boolean;
      serviceWorker: {
        register: (
          scriptUrl: string,
          options?: { scope?: string; updateViaCache?: "all" | "imports" | "none" },
        ) => Promise<Record<string, never>>;
      };
    };
    localStorage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };
    sessionStorage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };
    innerWidth: number;
    locationReloaded: boolean;
  };

  const initialUrl = new URL(href);
  windowObject.location = {
    href: initialUrl.toString(),
    protocol: initialUrl.protocol,
    host: initialUrl.host,
    reload: () => {
      windowObject.locationReloaded = true;
    },
  };

  const updateLocation = (url?: string | URL | null): void => {
    if (!url) {
      return;
    }

    const nextUrl = new URL(String(url), windowObject.location.href);
    windowObject.location.href = nextUrl.toString();
    windowObject.location.protocol = nextUrl.protocol;
    windowObject.location.host = nextUrl.host;
  };

  windowObject.history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      updateLocation(url);
    },
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
      replaceStateCalls.push(url);
      updateLocation(url);
    },
  };
  windowObject.fetch = async (input: unknown, init?: unknown) => {
    fetchCalls.push({ input, init });
    return fetchImplementation(input, init);
  };
  windowObject.setTimeout = (callback: () => void) => {
    const id = nextTimerId++;
    timers.set(id, callback);
    return id;
  };
  windowObject.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  windowObject.matchMedia = (query: string) => ({
    matches: options.mobile === true && query.includes("max-width"),
    media: query,
  });
  windowObject.navigator = {
    onLine: true,
    serviceWorker: {
      register: async (scriptUrl, serviceWorkerOptions) => {
        serviceWorkerRegistrations.push({
          scriptUrl,
          options: serviceWorkerOptions,
        });
        return {};
      },
    },
  };
  windowObject.localStorage = {
    getItem: (key: string) => localStorageEntries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageEntries.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageEntries.delete(key);
    },
  };
  windowObject.sessionStorage = {
    getItem: (key: string) => sessionStorageEntries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      sessionStorageEntries.set(key, value);
    },
    removeItem: (key: string) => {
      sessionStorageEntries.delete(key);
    },
  };
  windowObject.innerWidth = options.mobile === true ? 390 : 1280;
  windowObject.locationReloaded = false;

  const originalWindowDispatchEvent = windowObject.dispatchEvent.bind(windowObject);
  windowObject.dispatchEvent = (event: TestMessageEvent) => {
    if (event.type === "message") {
      dispatchedMessages.push(event.init.data);
    }
    return originalWindowDispatchEvent(event);
  };

  const context = vm.createContext({
    window: windowObject,
    document,
    URL,
    HTMLDivElement: TestHTMLDivElement,
    HTMLLinkElement: TestHTMLLinkElement,
    MutationObserver: TestMutationObserver,
    MessageEvent: TestMessageEvent,
    MouseEvent: TestMouseEvent,
    Request: TestRequest,
    Response: TestResponse,
    WebSocket: TestWebSocket,
    navigator: windowObject.navigator,
    localStorage: windowObject.localStorage,
    sessionStorage: windowObject.sessionStorage,
    Element: TestElement,
    Object,
    Array,
    Map,
    Set,
    Math,
    JSON,
    Promise,
    String,
    Number,
    Boolean,
    encodeURIComponent,
    decodeURIComponent,
  });

  return {
    document,
    windowObject,
    timers,
    fetchCalls,
    dispatchedMessages,
    replaceStateCalls,
    setFetchHandler(
      handler: (input: unknown, init?: unknown) => Promise<TestResponse> | TestResponse,
    ): void {
      fetchImplementation = async (input, init) => handler(input, init);
    },
    run(script: string): void {
      vm.runInContext(script, context);
    },
    getElectronBridge(): {
      sendMessageFromView: (message: unknown) => Promise<void>;
    } {
      return Reflect.get(windowObject, "electronBridge") as {
        sendMessageFromView: (message: unknown) => Promise<void>;
      };
    },
    emitServerEnvelope(envelope: unknown): void {
      const socket = TestWebSocket.latest;
      if (!socket) {
        throw new Error("No websocket connection was created.");
      }
      socket.emit("message", {
        data: JSON.stringify(envelope),
      });
    },
    openSocket(): void {
      const socket = TestWebSocket.latest;
      if (!socket) {
        throw new Error("No websocket connection was created.");
      }
      socket.readyState = TestWebSocket.OPEN;
      socket.emit("open", {});
    },
    getSentEnvelopes(): unknown[] {
      const socket = TestWebSocket.latest;
      if (!socket) {
        return [];
      }
      return socket.sentMessages.map((message) => JSON.parse(message) as unknown);
    },
    getLocalStorageValue(key: string): string | null {
      return localStorageEntries.get(key) ?? null;
    },
    getServiceWorkerRegistrations(): Array<{
      scriptUrl: string;
      options?: { scope?: string; updateViaCache?: "all" | "imports" | "none" };
    }> {
      return [...serviceWorkerRegistrations];
    },
  };
}

describe("renderBootstrapScript", () => {
  it("serializes config safely into the inline bootstrap", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "<preview>",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    expect(script).toContain("bootstrapPocodexInBrowser");
    expect(script).toContain('"stylesheetHref":"/pocodex.css"');
    expect(script).toContain('"importIconSvg":"\\u003csvg viewBox=\\"0 0 1 1\\">\\u003c/svg>"');
    expect(script).toContain('"appVersion":"\\u003cpreview>"');
    expect(script).not.toContain('"appVersion":"<preview>"');
    expect(script).not.toContain("</script>");
  });

  it("registers the Pocodex service worker outside dev mode", () => {
    const harness = createBootstrapHarness();
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    harness.run(script);

    expect(harness.getServiceWorkerRegistrations()).toEqual([
      {
        scriptUrl: "/service-worker.js",
        options: {
          scope: "/",
          updateViaCache: "none",
        },
      },
    ]);
  });

  it("offers reconnect and reload actions from the connection status overlay", async () => {
    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "expanded",
      },
    });
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    harness.run(script);
    await flushBootstrapMicrotasks();

    const firstSocket = TestWebSocket.latest;
    expect(firstSocket).toBeTruthy();

    harness.openSocket();
    await flushBootstrapMicrotasks();

    firstSocket?.emit("close", {
      code: 4000,
      reason: "heartbeat-timeout",
    });
    await flushBootstrapMicrotasks();

    const statusHost = harness.document.getElementById("pocodex-status-host");
    const reconnectButton = harness.document.querySelector(
      '[data-pocodex-status-action="reconnect"]',
    );
    const reloadButton = harness.document.querySelector('[data-pocodex-status-action="reload"]');
    const reconnectToast = harness.document.querySelector('[data-pocodex-toast="true"]');

    expect(statusHost?.hidden).toBe(false);
    expect(reconnectButton).toBeTruthy();
    expect(reloadButton).toBeTruthy();
    expect(reconnectToast).toBeNull();

    reloadButton?.click();
    expect(harness.windowObject.locationReloaded).toBe(true);

    reconnectButton?.click();
    drainTestTimers(harness.timers, 3);
    await flushBootstrapMicrotasks();

    expect(
      harness.fetchCalls.filter((call) => call.input === "/session-check?token=secret"),
    ).toHaveLength(2);
    expect(TestWebSocket.latest).not.toBe(firstSocket);
    expect(TestWebSocket.latest?.url).toBe("ws://127.0.0.1:8787/session?token=secret");
  });

  it("tracks the current route on the document element", () => {
    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/settings/general-settings?token=secret",
    });
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    harness.run(script);

    expect(harness.document.documentElement.dataset.pocodexRoute).toBe(
      "/settings/general-settings",
    );

    harness.windowObject.history.pushState(null, "", "/settings/agent");
    expect(harness.document.documentElement.dataset.pocodexRoute).toBe("/settings/agent");

    harness.windowObject.history.replaceState(null, "", "/");
    expect(harness.document.documentElement.dataset.pocodexRoute).toBe("/");
  });

  it("marks the document when the settings shell is present", () => {
    const harness = createBootstrapHarness();
    const settingsNav = harness.document.createElement("nav");
    settingsNav.setAttribute("aria-label", "Settings");
    harness.document.body.appendChild(settingsNav);

    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    harness.run(script);

    expect(harness.document.documentElement.dataset.pocodexSettingsShell).toBe("true");
  });

  it("persists the session token for standalone launches without a token query", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    const firstHarness = createBootstrapHarness();
    firstHarness.run(script);
    expect(firstHarness.getLocalStorageValue("__pocodex_token")).toBe("secret");

    const standaloneHarness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/",
      localStorageEntries: {
        __pocodex_token: "secret",
      },
    });
    standaloneHarness.run(script);

    expect(standaloneHarness.fetchCalls).toContainEqual({
      input: "/session-check?token=secret",
      init: {
        cache: "no-store",
        credentials: "same-origin",
      },
    });
  });

  it("validates without appending a token when the page URL has no token", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/",
    });
    harness.run(script);

    expect(harness.fetchCalls).toContainEqual({
      input: "/session-check",
      init: {
        cache: "no-store",
        credentials: "same-origin",
      },
    });
  });

  it("runs without throwing and installs the browser bridge", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    class Element {
      dataset: Record<string, string> = {};
      parentElement: Element | null = null;
      hidden = false;
      id = "";
      rel = "";
      href = "";
      textContent = "";

      appendChild<T extends Element>(child: T): T {
        child.parentElement = this;
        return child;
      }

      append(..._nodes: Element[]): void {}

      contains(_node: Element): boolean {
        return false;
      }

      replaceChildren(..._nodes: Element[]): void {}

      remove(): void {}

      after(_node: Element): void {}

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string): {
        length: number;
        item(index: number): Element | null;
        forEach(callback: (value: Element, key: number, parent: unknown) => void): void;
      } {
        return {
          length: 0,
          item: () => null,
          forEach: () => {},
        };
      }

      addEventListener(
        _type: string,
        _listener: (...args: unknown[]) => void,
        _options?: unknown,
      ): void {}

      getAttribute(_name: string): string | null {
        return null;
      }
    }

    class HTMLDivElement extends Element {}
    class HTMLLinkElement extends Element {}

    class Document extends Element {
      readyState = "complete";
      visibilityState = "visible";
      documentElement = new Element();
      head = new Element();
      body = new Element();

      createElement(tagName: string): Element {
        if (tagName === "div") {
          return new HTMLDivElement();
        }
        if (tagName === "link") {
          return new HTMLLinkElement();
        }
        return new Element();
      }

      getElementsByTagName(tagName: string): Element[] {
        return tagName === "head" ? [this.head] : [];
      }

      getElementById(_id: string): Element | null {
        return null;
      }

      hasFocus(): boolean {
        return true;
      }
    }

    class MutationObserver {
      constructor(_callback: (...args: unknown[]) => void) {}

      observe(_target: Element, _options: unknown): void {}
    }

    class Request {
      method = "GET";

      constructor(readonly url: string) {}
    }

    class Response {
      constructor(
        readonly body: string,
        readonly init: {
          status: number;
          headers: Record<string, string>;
        },
      ) {}
    }

    class MessageEvent {
      constructor(
        readonly type: string,
        readonly init: { data: unknown },
      ) {}
    }

    class WebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = WebSocket.CONNECTING;

      constructor(readonly url: string) {}

      addEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}

      send(_message: string): void {}

      close(_code?: number, _reason?: string): void {
        this.readyState = WebSocket.CLOSED;
      }
    }

    const storage = new Map<string, string>();
    const document = new Document();
    const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
    const windowObject = {
      location: {
        href: "http://127.0.0.1:8787/?token=secret",
        protocol: "http:",
        host: "127.0.0.1:8787",
      },
      history: {
        pushState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
        replaceState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
      },
      fetch: async (input: unknown, init?: unknown) => {
        fetchCalls.push({ input, init });
        return { ok: true, status: 200 };
      },
      setTimeout: (_callback: () => void, _delay: number) => 0,
      clearTimeout: (_id: number) => {},
      addEventListener: (
        _type: string,
        _listener: (...args: unknown[]) => void,
        _options?: unknown,
      ) => {},
      dispatchEvent: (_event: unknown) => true,
      locationReloaded: false,
    };

    Object.assign(windowObject.location, {
      reload: () => {
        windowObject.locationReloaded = true;
      },
    });

    const context = vm.createContext({
      window: windowObject,
      document,
      URL,
      HTMLDivElement,
      HTMLLinkElement,
      MutationObserver,
      MessageEvent,
      Request,
      Response,
      WebSocket,
      sessionStorage: {
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        getItem: (key: string) => storage.get(key) ?? null,
      },
      Element,
      Object,
      Array,
      Map,
      Set,
      Math,
      JSON,
      Promise,
      String,
      Number,
      Boolean,
      encodeURIComponent,
    });

    expect(() => vm.runInContext(script, context)).not.toThrow();
    expect(typeof Reflect.get(windowObject, "electronBridge")).toBe("object");
    expect(Reflect.get(windowObject, "codexWindowType")).toBe("electron");

    const patchedFetch = windowObject.fetch as typeof fetch;
    void patchedFetch("vscode://codex/ipc-request", {
      method: "POST",
      body: '{"method":"ping"}',
      headers: {
        "content-type": "application/json",
      },
    });

    expect(fetchCalls.at(-1)).toEqual({
      input: "/ipc-request",
      init: {
        method: "POST",
        body: '{"method":"ping"}',
        headers: {
          "content-type": "application/json",
        },
        cache: "no-store",
        credentials: "same-origin",
      },
    });
  });

  it("handles Add photos & files menu clicks locally by clicking the browser file input", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    harness.run(script);

    const input = harness.document.createElement("input");
    input.setAttribute("type", "file");
    input.setAttribute("multiple", "");

    let clickCount = 0;
    input.addEventListener("click", () => {
      clickCount += 1;
    });

    const menuItem = harness.document.createElement("div");
    menuItem.setAttribute("role", "menuitem");
    menuItem.textContent = "Add photos & files";
    const label = harness.document.createElement("span");
    menuItem.appendChild(label);

    harness.document.body.appendChild(input);
    harness.document.body.appendChild(menuItem);

    const event = new TestMouseEvent("click", { target: label });
    harness.document.dispatchEvent(event);

    expect(clickCount).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(event.immediatePropagationStopped).toBe(true);
  });

  it("does not intercept Add photos & files menu clicks when the browser file input is missing", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    harness.run(script);

    const menuItem = harness.document.createElement("div");
    menuItem.setAttribute("role", "menuitem");
    menuItem.textContent = "Add photos & files";
    const label = harness.document.createElement("span");
    menuItem.appendChild(label);
    harness.document.body.appendChild(menuItem);

    const event = new TestMouseEvent("click", { target: label });
    harness.document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(event.immediatePropagationStopped).toBe(false);
  });

  it("restores the last in-app route and persists history changes", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    class EventTargetLike {
      addEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}

      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }

    class Element extends EventTargetLike {
      dataset: Record<string, string> = {};
      parentElement: Element | null = null;
      hidden = false;
      id = "";
      rel = "";
      href = "";
      textContent = "";

      appendChild<T extends Element>(child: T): T {
        child.parentElement = this;
        return child;
      }

      append(..._nodes: Element[]): void {}

      contains(_node: Element): boolean {
        return false;
      }

      replaceChildren(..._nodes: Element[]): void {}

      remove(): void {}

      after(_node: Element): void {}

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string): {
        length: number;
        item(index: number): Element | null;
        forEach(callback: (value: Element, key: number, parent: unknown) => void): void;
      } {
        return {
          length: 0,
          item: () => null,
          forEach: () => {},
        };
      }

      getAttribute(_name: string): string | null {
        return null;
      }
    }

    class HTMLDivElement extends Element {}
    class HTMLLinkElement extends Element {}

    class Document extends EventTargetLike {
      readyState = "complete";
      visibilityState = "visible";
      documentElement = new Element();
      head = new Element();
      body = new Element();

      createElement(tagName: string): Element {
        if (tagName === "div") {
          return new HTMLDivElement();
        }
        if (tagName === "link") {
          return new HTMLLinkElement();
        }
        return new Element();
      }

      getElementsByTagName(tagName: string): Element[] {
        return tagName === "head" ? [this.head] : [];
      }

      querySelector(selector: string): Element | null {
        return this.documentElement.querySelector(selector);
      }

      querySelectorAll(selector: string) {
        return this.documentElement.querySelectorAll(selector);
      }

      getElementById(_id: string): Element | null {
        return null;
      }

      hasFocus(): boolean {
        return true;
      }
    }

    class MutationObserver {
      constructor(_callback: (...args: unknown[]) => void) {}

      observe(_target: Element, _options: unknown): void {}
    }

    class Request {
      method = "GET";

      constructor(readonly url: string) {}
    }

    class Response {
      constructor(
        readonly body: string,
        readonly init: {
          status: number;
          headers: Record<string, string>;
        },
      ) {}
    }

    class MessageEvent {
      constructor(
        readonly type: string,
        readonly init: { data: unknown },
      ) {}
    }

    class WebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = WebSocket.CONNECTING;

      constructor(readonly url: string) {}

      addEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}

      send(_message: string): void {}

      close(_code?: number, _reason?: string): void {
        this.readyState = WebSocket.CLOSED;
      }
    }

    const storage = new Map<string, string>([
      ["__pocodex_token", "secret"],
      ["__pocodex_last_route", "/local/thread-1"],
    ]);
    const document = new Document();
    const windowObject = new EventTargetLike() as EventTargetLike & {
      location: {
        href: string;
        protocol: string;
        host: string;
        reload: () => void;
      };
      history: {
        pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
      };
      fetch: (input: unknown, init?: unknown) => Promise<unknown>;
      setTimeout: (callback: () => void, delay: number) => number;
      clearTimeout: (id: number) => void;
    };

    const updateLocation = (url?: string | URL | null) => {
      if (!url) {
        return;
      }
      const next = new URL(String(url), windowObject.location.href);
      windowObject.location.href = next.toString();
      windowObject.location.protocol = next.protocol;
      windowObject.location.host = next.host;
    };

    windowObject.location = {
      href: "http://127.0.0.1:8787/",
      protocol: "http:",
      host: "127.0.0.1:8787",
      reload: () => {},
    };
    windowObject.history = {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        updateLocation(url);
      },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        updateLocation(url);
      },
    };
    windowObject.fetch = async () => ({ ok: true, status: 200 });
    windowObject.setTimeout = (_callback: () => void, _delay: number) => 0;
    windowObject.clearTimeout = (_id: number) => {};

    const context = vm.createContext({
      window: windowObject,
      document,
      URL,
      HTMLDivElement,
      HTMLLinkElement,
      MutationObserver,
      MessageEvent,
      Request,
      Response,
      WebSocket,
      sessionStorage: {
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        getItem: (key: string) => storage.get(key) ?? null,
      },
      Element,
      Object,
      Array,
      Map,
      Set,
      Math,
      JSON,
      Promise,
      String,
      Number,
      Boolean,
      encodeURIComponent,
    });

    vm.runInContext(script, context);

    expect(windowObject.location.href).toBe("http://127.0.0.1:8787/?thread=thread-1");

    windowObject.history.pushState(null, "", "/local/thread-2?view=diff&token=secret#panel");

    expect(storage.get("__pocodex_last_route")).toBe("/local/thread-2?view=diff#panel");
  });

  it("closes the mobile sidebar after clicking thread and new-thread navigation in the sidebar", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    type Listener = (...args: unknown[]) => void;

    class EventTargetLike {
      private readonly listeners = new Map<string, Listener[]>();

      addEventListener(type: string, listener: Listener, _options?: unknown): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
      }

      dispatchEvent(event: { type: string }): boolean {
        const listeners = this.listeners.get(event.type) ?? [];
        for (const listener of listeners) {
          listener(event);
        }
        return true;
      }
    }

    class Element extends EventTargetLike {
      readonly children: Element[] = [];
      readonly dataset: Record<string, string> = {};
      parentElement: Element | null = null;
      hidden = false;
      className = "";
      id = "";
      rel = "";
      href = "";
      textContent = "";
      style: Record<string, string> = {};
      private readonly attributes = new Map<string, string>();
      private rectLeft = 0;
      private rectWidth = 0;

      constructor(readonly tagName: string) {
        super();
      }

      appendChild<T extends Element>(child: T): T {
        child.parentElement = this;
        this.children.push(child);
        return child;
      }

      append(...nodes: Element[]): void {
        for (const node of nodes) {
          this.appendChild(node);
        }
      }

      contains(node: Element): boolean {
        let current: Element | null = node;
        while (current) {
          if (current === this) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }

      replaceChildren(...nodes: Element[]): void {
        for (const child of this.children) {
          child.parentElement = null;
        }
        this.children.length = 0;
        this.append(...nodes);
      }

      remove(): void {
        if (!this.parentElement) {
          return;
        }
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) {
          this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
      }

      after(node: Element): void {
        if (!this.parentElement) {
          return;
        }
        const siblings = this.parentElement.children;
        const index = siblings.indexOf(this);
        if (index === -1) {
          return;
        }
        node.parentElement = this.parentElement;
        siblings.splice(index + 1, 0, node);
      }

      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
        if (name === "id") {
          this.id = value;
        }
        if (name === "class") {
          this.className = value;
        }
        if (name.startsWith("data-")) {
          const datasetKey = name
            .slice("data-".length)
            .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
          this.dataset[datasetKey] = value;
        }
      }

      getAttribute(name: string): string | null {
        if (name === "id") {
          return this.id || null;
        }
        return this.attributes.get(name) ?? null;
      }

      setBoundingClientRect(rect: { left?: number; width?: number }): void {
        if (typeof rect.left === "number") {
          this.rectLeft = rect.left;
        }
        if (typeof rect.width === "number") {
          this.rectWidth = rect.width;
        }
      }

      getBoundingClientRect() {
        return {
          left: this.rectLeft,
          top: 0,
          right: this.rectLeft + this.rectWidth,
          bottom: 0,
          width: this.rectWidth,
          height: 0,
          x: this.rectLeft,
          y: 0,
          toJSON: () => null,
        };
      }

      querySelector(selector: string): Element | null {
        for (const child of this.children) {
          if (matchesSelector(child, selector)) {
            return child;
          }
          const nested = child.querySelector(selector);
          if (nested) {
            return nested;
          }
        }
        return null;
      }

      querySelectorAll(selector: string): {
        length: number;
        item(index: number): Element | null;
        forEach(callback: (value: Element, key: number, parent: unknown) => void): void;
      } {
        const matches: Element[] = [];
        if (selector === ":scope > button") {
          for (const child of this.children) {
            if (matchesSelector(child, "button")) {
              matches.push(child);
            }
          }
          return createNodeList(matches);
        }

        for (const child of this.children) {
          collectMatches(child, selector, matches);
        }
        return createNodeList(matches);
      }

      closest(selector: string): Element | null {
        if (matchesSelector(this, selector)) {
          return this;
        }

        return this.parentElement?.closest(selector) ?? null;
      }
    }

    class HTMLDivElement extends Element {
      constructor() {
        super("DIV");
      }
    }

    class HTMLLinkElement extends Element {
      constructor() {
        super("LINK");
      }
    }

    class Document extends EventTargetLike {
      readyState = "complete";
      visibilityState = "visible";
      documentElement = new Element("HTML");
      head = new Element("HEAD");
      body = new Element("BODY");

      constructor() {
        super();
        this.documentElement.append(this.head, this.body);
      }

      createElement(tagName: string): Element {
        switch (tagName.toLowerCase()) {
          case "div":
            return new HTMLDivElement();
          case "link":
            return new HTMLLinkElement();
          default:
            return new Element(tagName.toUpperCase());
        }
      }

      querySelector(selector: string): Element | null {
        return this.documentElement.querySelector(selector);
      }

      querySelectorAll(selector: string) {
        return this.documentElement.querySelectorAll(selector);
      }

      getElementsByTagName(tagName: string): Element[] {
        return tagName === "head" ? [this.head] : [];
      }

      getElementById(id: string): Element | null {
        return findById(this.documentElement, id);
      }

      hasFocus(): boolean {
        return true;
      }
    }

    class MutationObserver {
      constructor(_callback: (...args: unknown[]) => void) {}

      observe(_target: Element, _options: unknown): void {}
    }

    class Request {
      method = "GET";

      constructor(readonly url: string) {}
    }

    class Response {
      constructor(
        readonly body: string,
        readonly init: {
          status: number;
          headers: Record<string, string>;
        },
      ) {}
    }

    class MessageEvent {
      constructor(
        readonly type: string,
        readonly init: { data: unknown },
      ) {}
    }

    class MouseEvent {
      readonly button: number;
      readonly target: Element;
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      readonly altKey: boolean;
      readonly shiftKey: boolean;
      defaultPrevented = false;

      constructor(
        readonly type: string,
        options: {
          button?: number;
          target: Element;
          metaKey?: boolean;
          ctrlKey?: boolean;
          altKey?: boolean;
          shiftKey?: boolean;
        },
      ) {
        this.button = options.button ?? 0;
        this.target = options.target;
        this.metaKey = options.metaKey ?? false;
        this.ctrlKey = options.ctrlKey ?? false;
        this.altKey = options.altKey ?? false;
        this.shiftKey = options.shiftKey ?? false;
      }

      preventDefault(): void {
        this.defaultPrevented = true;
      }
    }

    class WebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = WebSocket.CONNECTING;

      constructor(readonly url: string) {}

      addEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}

      send(_message: string): void {}

      close(_code?: number, _reason?: string): void {
        this.readyState = WebSocket.CLOSED;
      }
    }

    const storage = new Map<string, string>();
    const timers = new Map<number, () => void>();
    const dispatchedMessages: unknown[] = [];
    let nextTimerId = 1;

    const document = new Document();
    const fetchCalls: Array<{ input: unknown; init: unknown }> = [];

    const windowObject = new EventTargetLike() as EventTargetLike & {
      location: {
        href: string;
        protocol: string;
        host: string;
        reload: () => void;
      };
      history: {
        pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
      };
      fetch: (input: unknown, init?: unknown) => Promise<unknown>;
      setTimeout: (callback: () => void, delay: number) => number;
      clearTimeout: (id: number) => void;
      matchMedia: (query: string) => { matches: boolean; media: string };
      innerWidth: number;
      locationReloaded: boolean;
    };

    windowObject.location = {
      href: "http://127.0.0.1:8787/local/thread-1?token=secret",
      protocol: "http:",
      host: "127.0.0.1:8787",
      reload: () => {
        windowObject.locationReloaded = true;
      },
    };
    windowObject.fetch = async (input: unknown, init?: unknown) => {
      fetchCalls.push({ input, init });
      return { ok: true, status: 200 };
    };
    windowObject.history = {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        updateLocation(url);
      },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        updateLocation(url);
      },
    };
    windowObject.setTimeout = (callback: () => void) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    };
    windowObject.clearTimeout = (id: number) => {
      timers.delete(id);
    };
    windowObject.matchMedia = (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
    });
    windowObject.innerWidth = 390;
    windowObject.locationReloaded = false;

    function updateLocation(url?: string | URL | null): void {
      if (!url) {
        return;
      }

      const nextUrl = new URL(String(url), windowObject.location.href);
      windowObject.location.href = nextUrl.toString();
      windowObject.location.protocol = nextUrl.protocol;
      windowObject.location.host = nextUrl.host;
    }

    const originalWindowDispatchEvent = windowObject.dispatchEvent.bind(windowObject);
    windowObject.dispatchEvent = (event: MessageEvent) => {
      if (event.type === "message") {
        dispatchedMessages.push(event.init.data);
      }
      return originalWindowDispatchEvent(event);
    };

    const nav = document.createElement("nav");
    nav.setAttribute("role", "navigation");
    const newThreadButton = document.createElement("button");
    newThreadButton.textContent = "New thread";
    nav.appendChild(newThreadButton);
    const projectNewThreadButton = document.createElement("button");
    projectNewThreadButton.setAttribute("aria-label", "Start new thread in pocodex");
    nav.appendChild(projectNewThreadButton);
    const threadList = document.createElement("div");
    threadList.setAttribute("role", "list");
    const listItem = document.createElement("div");
    listItem.setAttribute("role", "listitem");
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    const rowActions = document.createElement("div");
    const archiveButton = document.createElement("button");
    archiveButton.setAttribute("aria-label", "Archive thread");
    rowActions.appendChild(archiveButton);
    const title = document.createElement("span");
    title.textContent = "Close sidebar when opening thread";
    row.append(rowActions, title);
    listItem.appendChild(row);
    threadList.appendChild(listItem);
    nav.appendChild(threadList);
    document.body.appendChild(nav);
    const contentPane = document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    contentPane.style.width = "calc(100% - var(--spacing-token-sidebar))";
    contentPane.style.transform = "translateX(var(--spacing-token-sidebar))";
    const contentChild = document.createElement("div");
    contentPane.appendChild(contentChild);
    document.body.appendChild(contentPane);

    const context = vm.createContext({
      window: windowObject,
      document,
      URL,
      HTMLDivElement,
      HTMLLinkElement,
      MutationObserver,
      MessageEvent,
      MouseEvent,
      Request,
      Response,
      WebSocket,
      sessionStorage: {
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        getItem: (key: string) => storage.get(key) ?? null,
      },
      Element,
      Object,
      Array,
      Map,
      Set,
      Math,
      JSON,
      Promise,
      String,
      Number,
      Boolean,
      encodeURIComponent,
    });

    vm.runInContext(script, context);

    document.dispatchEvent(new MouseEvent("click", { target: title }));
    drainTimers(timers);

    expect(fetchCalls).not.toHaveLength(0);
    expect(dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    dispatchedMessages.length = 0;
    document.dispatchEvent(new MouseEvent("click", { target: archiveButton }));
    drainTimers(timers);

    expect(dispatchedMessages).not.toContainEqual({ type: "toggle-sidebar" });

    dispatchedMessages.length = 0;
    document.dispatchEvent(new MouseEvent("click", { target: newThreadButton }));
    drainTimers(timers);

    expect(dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    dispatchedMessages.length = 0;
    document.dispatchEvent(new MouseEvent("click", { target: projectNewThreadButton }));
    drainTimers(timers);

    expect(dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    dispatchedMessages.length = 0;
    document.dispatchEvent(new MouseEvent("click", { target: contentChild }));
    drainTimers(timers);

    expect(dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    dispatchedMessages.length = 0;
    contentPane.style.width = "100%";
    contentPane.style.transform = "translateX(0)";
    document.dispatchEvent(new MouseEvent("click", { target: contentChild }));
    drainTimers(timers);

    expect(dispatchedMessages).not.toContainEqual({ type: "toggle-sidebar" });

    dispatchedMessages.length = 0;
    contentPane.style.width = "";
    contentPane.style.transform = "";
    contentPane.setBoundingClientRect({ left: 240, width: 150 });
    document.dispatchEvent(new MouseEvent("click", { target: newThreadButton }));
    drainTimers(timers);

    expect(dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    function createNodeList(matches: Element[]) {
      return {
        length: matches.length,
        item(index: number): Element | null {
          return matches[index] ?? null;
        },
        forEach(callback: (value: Element, key: number, parent: unknown) => void): void {
          matches.forEach((value, index) => callback(value, index, matches));
        },
      };
    }

    function collectMatches(element: Element, selector: string, matches: Element[]): void {
      if (matchesSelector(element, selector)) {
        matches.push(element);
      }
      for (const child of element.children) {
        collectMatches(child, selector, matches);
      }
    }

    function findById(element: Element, id: string): Element | null {
      if (element.id === id) {
        return element;
      }
      for (const child of element.children) {
        const match = findById(child, id);
        if (match) {
          return match;
        }
      }
      return null;
    }

    function matchesSelector(element: Element, selector: string): boolean {
      return selector
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .some((part) => matchesSingleSelector(element, part));
    }

    function matchesSingleSelector(element: Element, selector: string): boolean {
      if (selector === "[data-thread-title]") {
        return "threadTitle" in element.dataset;
      }

      if (selector.startsWith(".")) {
        return element.className
          .split(/\s+/)
          .filter((part) => part.length > 0)
          .includes(selector.slice(1));
      }

      const roleMatch = /^(?:(\w+))?\[role=['"]([^'"]+)['"]\]$/.exec(selector);
      if (roleMatch) {
        const [, tagName, role] = roleMatch;
        return (
          (tagName === undefined || element.tagName === tagName.toUpperCase()) &&
          element.getAttribute("role") === role
        );
      }

      return element.tagName === selector.toUpperCase();
    }

    function drainTimers(pendingTimers: Map<number, () => void>, maxRuns = 20): void {
      for (let index = 0; index < maxRuns; index += 1) {
        const next = pendingTimers.entries().next().value as [number, () => void] | undefined;
        if (!next) {
          return;
        }
        const [timerId, callback] = next;
        pendingTimers.delete(timerId);
        callback();
      }
    }
  });

  type EnterBehaviorHarnessOptions = {
    activeElement?: {
      tagName: string;
      type?: string;
      contentEditable?: boolean;
    } | null;
    innerHeight?: number;
    touchCapable?: boolean;
    visualViewportHeight?: number | null;
  };

  async function createEnterBehaviorHarness(options: EnterBehaviorHarnessOptions = {}) {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    type Listener = (...args: unknown[]) => void;

    class EventTargetLike {
      private readonly listeners = new Map<string, Listener[]>();

      addEventListener(type: string, listener: Listener, _options?: unknown): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
      }

      dispatchEvent(event: { type: string }): boolean {
        const listeners = this.listeners.get(event.type) ?? [];
        for (const listener of listeners) {
          listener(event);
        }
        return true;
      }
    }

    class Element extends EventTargetLike {
      readonly tagName: string;
      private readonly attributes = new Map<string, string>();
      dataset: Record<string, string> = {};
      parentElement: Element | null = null;
      hidden = false;
      id = "";
      rel = "";
      href = "";
      textContent = "";

      constructor(tagName = "DIV") {
        super();
        this.tagName = tagName.toUpperCase();
      }

      appendChild<T extends Element>(child: T): T {
        child.parentElement = this;
        return child;
      }

      append(..._nodes: Element[]): void {}

      contains(_node: Element): boolean {
        return false;
      }

      replaceChildren(..._nodes: Element[]): void {}

      remove(): void {}

      after(_node: Element): void {}

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string): {
        length: number;
        item(index: number): Element | null;
        forEach(callback: (value: Element, key: number, parent: unknown) => void): void;
      } {
        return {
          length: 0,
          item: () => null,
          forEach: () => {},
        };
      }

      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }

      getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
      }
    }

    class HTMLDivElement extends Element {
      constructor() {
        super("DIV");
      }
    }

    class HTMLLinkElement extends Element {
      constructor() {
        super("LINK");
      }
    }

    class Document extends EventTargetLike {
      readyState = "complete";
      visibilityState = "visible";
      activeElement: Element | null = null;
      documentElement = new Element("HTML");
      head = new Element("HEAD");
      body = new Element("BODY");

      createElement(tagName: string): Element {
        if (tagName === "div") {
          return new HTMLDivElement();
        }
        if (tagName === "link") {
          return new HTMLLinkElement();
        }
        return new Element(tagName);
      }

      getElementsByTagName(tagName: string): Element[] {
        return tagName === "head" ? [this.head] : [];
      }

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string) {
        return {
          length: 0,
          item: () => null,
          forEach: () => {},
        };
      }

      getElementById(_id: string): Element | null {
        return null;
      }

      hasFocus(): boolean {
        return true;
      }
    }

    class VisualViewport extends EventTargetLike {
      constructor(public height: number) {
        super();
      }
    }

    class MutationObserver {
      constructor(_callback: (...args: unknown[]) => void) {}

      observe(_target: Element, _options: unknown): void {}
    }

    class Request {
      method = "GET";

      constructor(readonly url: string) {}
    }

    class Response {
      constructor(
        readonly body: string,
        readonly init: {
          status: number;
          headers: Record<string, string>;
        },
      ) {}
    }

    class MessageEvent {
      constructor(
        readonly type: string,
        readonly init: { data: unknown },
      ) {}
    }

    class WebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static latest: WebSocket | null = null;

      readonly listeners = new Map<string, Listener[]>();
      readyState = WebSocket.CONNECTING;

      constructor(readonly url: string) {
        WebSocket.latest = this;
      }

      addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
      }

      send(_message: string): void {}

      close(_code?: number, _reason?: string): void {
        this.readyState = WebSocket.CLOSED;
      }

      emit(type: string, event: unknown): void {
        const listeners = this.listeners.get(type) ?? [];
        for (const listener of listeners) {
          listener(event);
        }
      }
    }

    const dispatchedMessages: unknown[] = [];
    const storage = new Map<string, string>();
    const document = new Document();
    const innerHeight = options.innerHeight ?? 900;
    const visualViewport =
      options.visualViewportHeight === null
        ? null
        : new VisualViewport(options.visualViewportHeight ?? innerHeight);
    const windowObject = new EventTargetLike() as EventTargetLike & {
      innerHeight: number;
      location: {
        href: string;
        protocol: string;
        host: string;
        reload: () => void;
      };
      history: {
        pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
      };
      fetch: (input: unknown, init?: unknown) => Promise<unknown>;
      setTimeout: (callback: () => void, delay: number) => number;
      clearTimeout: (id: number) => void;
      matchMedia: (query: string) => { matches: boolean; media: string };
      visualViewport?: VisualViewport;
    };

    function createActiveElement(
      definition: EnterBehaviorHarnessOptions["activeElement"],
    ): Element | null {
      if (!definition) {
        return null;
      }

      const element = new Element(definition.tagName);
      if (definition.type) {
        element.setAttribute("type", definition.type);
      }
      if (definition.contentEditable) {
        element.setAttribute("contenteditable", "true");
      }
      return element;
    }

    document.activeElement = createActiveElement(options.activeElement ?? null);

    windowObject.innerHeight = innerHeight;
    windowObject.location = {
      href: "http://127.0.0.1:8787/local/thread-1?token=secret",
      protocol: "http:",
      host: "127.0.0.1:8787",
      reload: () => {},
    };
    windowObject.history = {
      pushState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
      replaceState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
    };
    windowObject.fetch = async () => ({ ok: true, status: 200 });
    windowObject.setTimeout = (_callback: () => void) => 0;
    windowObject.clearTimeout = (_id: number) => {};
    windowObject.matchMedia = (query: string) => ({
      matches: Boolean(options.touchCapable) && query.includes("pointer: coarse"),
      media: query,
    });
    if (visualViewport) {
      windowObject.visualViewport = visualViewport;
    }

    const originalWindowDispatchEvent = windowObject.dispatchEvent.bind(windowObject);
    windowObject.dispatchEvent = (event: MessageEvent) => {
      if (event.type === "message") {
        dispatchedMessages.push(event.init.data);
      }
      return originalWindowDispatchEvent(event);
    };

    const context = vm.createContext({
      window: windowObject,
      document,
      URL,
      HTMLDivElement,
      HTMLLinkElement,
      MutationObserver,
      MessageEvent,
      Request,
      Response,
      WebSocket,
      navigator: {
        maxTouchPoints: options.touchCapable ? 5 : 0,
      },
      sessionStorage: {
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        getItem: (key: string) => storage.get(key) ?? null,
      },
      Element,
      Object,
      Array,
      Map,
      Set,
      Math,
      JSON,
      Promise,
      String,
      Number,
      Boolean,
      encodeURIComponent,
    });

    vm.runInContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const socket = WebSocket.latest;
    expect(socket).not.toBeNull();

    return {
      dispatchedMessages,
      emitBridgeMessage(message: unknown) {
        socket?.emit("message", {
          data: JSON.stringify({
            type: "bridge_message",
            message,
          }),
        });
      },
      setActiveElement(definition: EnterBehaviorHarnessOptions["activeElement"]) {
        document.activeElement = createActiveElement(definition);
        document.dispatchEvent({
          type: definition ? "focusin" : "focusout",
        });
      },
      setVisualViewportHeight(nextHeight: number) {
        if (!visualViewport) {
          throw new Error("visualViewport is not available in this harness");
        }
        visualViewport.height = nextHeight;
        visualViewport.dispatchEvent({ type: "resize" });
      },
    };
  }

  it("forces newline enter behavior while a soft keyboard is visible and restores the host value when it closes", async () => {
    const harness = await createEnterBehaviorHarness({
      touchCapable: true,
      activeElement: {
        tagName: "textarea",
      },
      innerHeight: 900,
      visualViewportHeight: 540,
    });

    harness.emitBridgeMessage({
      type: "persisted-atom-sync",
      state: {
        "enter-behavior": "enter",
        "agent-mode": "auto",
      },
    });

    expect(harness.dispatchedMessages).toContainEqual({
      type: "persisted-atom-sync",
      state: {
        "enter-behavior": "newline",
        "agent-mode": "auto",
      },
    });

    harness.setVisualViewportHeight(900);

    expect(harness.dispatchedMessages.at(-1)).toEqual({
      type: "persisted-atom-updated",
      key: "enter-behavior",
      value: "enter",
      deleted: false,
    });

    harness.setVisualViewportHeight(540);

    expect(harness.dispatchedMessages.at(-1)).toEqual({
      type: "persisted-atom-updated",
      key: "enter-behavior",
      value: "newline",
      deleted: false,
    });
  });

  it("falls back to touch input focus when visualViewport is unavailable", async () => {
    const harness = await createEnterBehaviorHarness({
      touchCapable: true,
      activeElement: {
        tagName: "textarea",
      },
      visualViewportHeight: null,
    });

    harness.emitBridgeMessage({
      type: "persisted-atom-sync",
      state: {
        "enter-behavior": "enter",
        "agent-mode": "auto",
      },
    });

    expect(harness.dispatchedMessages).toContainEqual({
      type: "persisted-atom-sync",
      state: {
        "enter-behavior": "newline",
        "agent-mode": "auto",
      },
    });

    harness.setActiveElement(null);

    expect(harness.dispatchedMessages.at(-1)).toEqual({
      type: "persisted-atom-updated",
      key: "enter-behavior",
      value: "enter",
      deleted: false,
    });
  });

  it("includes home-directory path shortening in the import dialog bootstrap", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });
    expect(script).toMatch(
      /currentFolderPath\.textContent\s*=\s*currentRoot\s*\?\s*formatDesktopImportPath\(currentRoot\)/,
    );
    expect(script).toMatch(/entryPath\.textContent\s*=\s*formatDesktopImportPath\(entry\.path\)/);
    expect(script).toMatch(/\^\\\/\(\?:users\|home\)\\\/\[\^\/\]\+\(\?=\\\/\|\$\)\/i/);
    expect(script).toMatch(
      /trimmedPath\.replace\(\s*\/\^\\\/\(\?:users\|home\)\\\/\[\^\/\]\+\(\?=\\\/\|\$\)\/i,\s*"~"\s*\)/,
    );
  });

  it("restores the desktop sidebar mode from browser storage and persists later changes", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      localStorageEntries: {
        "pocodex-sidebar-mode": "collapsed",
      },
    });
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    contentPane.setBoundingClientRect({ left: 300, width: 980 });
    const toggleButton = harness.document.createElement("button");
    toggleButton.setAttribute("aria-label", "Show sidebar");
    harness.document.body.appendChild(contentPane);
    harness.document.body.appendChild(toggleButton);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers, 1);

    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    contentPane.setBoundingClientRect({ left: 0, width: 1280 });
    drainTestTimers(harness.timers);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");

    contentPane.setBoundingClientRect({ left: 300, width: 980 });
    harness.document.dispatchEvent(new TestMouseEvent("click", { target: toggleButton }));
    drainTestTimers(harness.timers);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("expanded");
  });

  it("keeps the desktop sidebar expanded when no host mode has been stored", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    contentPane.setBoundingClientRect({ left: 300, width: 980 });
    harness.document.body.appendChild(contentPane);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "persisted-atom-sync",
        state: {},
      },
    });

    drainTestTimers(harness.timers);

    expect(harness.dispatchedMessages).not.toContainEqual({ type: "toggle-sidebar" });
  });

  it("reapplies the stored desktop sidebar mode when the shell resets after restore", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      localStorageEntries: {
        "pocodex-sidebar-mode": "collapsed",
      },
    });
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface left-token-sidebar");
    contentPane.setBoundingClientRect({ left: 300, width: 980 });
    harness.document.body.appendChild(contentPane);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers, 1);
    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    contentPane.setAttribute("class", "main-surface left-0");
    contentPane.setBoundingClientRect({ left: 0, width: 1280 });
    harness.windowObject.dispatchEvent({ type: "resize" });
    drainTestTimers(harness.timers);

    contentPane.setAttribute("class", "main-surface left-token-sidebar");
    contentPane.setBoundingClientRect({ left: 300, width: 980 });
    harness.windowObject.dispatchEvent({ type: "resize" });
    for (let index = 0; index < 5; index += 1) {
      const toggleMessages = harness.dispatchedMessages.filter(
        (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
      );
      if (toggleMessages.length >= 2) {
        break;
      }
      drainTestTimers(harness.timers, 1);
    }

    const toggleMessages = harness.dispatchedMessages.filter(
      (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
    );
    expect(toggleMessages).toHaveLength(2);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("migrates the sidebar mode from host persisted atoms when browser storage is empty", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    contentPane.setBoundingClientRect({ left: 300, width: 980 });
    harness.document.body.appendChild(contentPane);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "persisted-atom-sync",
        state: {
          "pocodex-sidebar-mode": "collapsed",
        },
      },
    });

    drainTestTimers(harness.timers, 1);

    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });
    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("restores the mobile sidebar mode from browser storage and persists later changes", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "collapsed",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    const toggleButton = harness.document.createElement("button");
    toggleButton.setAttribute("aria-label", "Show sidebar");
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    harness.document.body.appendChild(toggleButton);
    setMobileSidebarOpenState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers, 1);
    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    contentPane.style.width = "100%";
    contentPane.style.transform = "translateX(0)";
    contentPane.setBoundingClientRect({ left: 0, width: 390 });
    navigation.setBoundingClientRect({ left: 0, width: 240 });
    drainTestTimers(harness.timers);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");

    setMobileSidebarOpenState(contentPane, navigation);
    harness.document.dispatchEvent(new TestMouseEvent("click", { target: toggleButton }));
    drainTestTimers(harness.timers);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("expanded");
  });

  it("falls back to host sidebar toggle when toolbar click leaves mode unchanged", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });
    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "expanded",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    const toggleButton = harness.document.createElement("button");
    toggleButton.setAttribute("aria-label", "Sidebar");
    toggleButton.setAttribute("title", "Hide sidebar");
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    harness.document.body.appendChild(toggleButton);
    setMobileSidebarOpenState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();
    drainTestTimers(harness.timers);
    harness.dispatchedMessages.length = 0;

    harness.document.dispatchEvent(new TestMouseEvent("click", { target: toggleButton }));
    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
    drainTestTimers(harness.timers);

    expect(harness.dispatchedMessages).toEqual([{ type: "toggle-sidebar" }]);
    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("defaults the mobile sidebar to expanded when no host mode has been stored", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "expanded",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarClosedState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "persisted-atom-sync",
        state: {},
      },
    });

    drainTestTimers(harness.timers, 1);
    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });
  });

  it("persists mobile sidebar closes triggered from the content pane", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "expanded",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    const contentChild = harness.document.createElement("div");
    contentPane.appendChild(contentChild);
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarOpenState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers);
    harness.dispatchedMessages.length = 0;

    harness.document.dispatchEvent(new TestMouseEvent("click", { target: contentChild }));
    for (let index = 0; index < 5; index += 1) {
      if (
        harness.dispatchedMessages.some(
          (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
        )
      ) {
        break;
      }
      drainTestTimers(harness.timers, 1);
    }
    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    setMobileSidebarClosedState(contentPane, navigation);
    drainTestTimers(harness.timers);

    const toggleMessages = harness.dispatchedMessages.filter(
      (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
    );
    expect(toggleMessages).toHaveLength(1);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("does not treat the mobile sidebar as open when the content pane has the collapsed class", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "collapsed",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface left-0");
    const contentChild = harness.document.createElement("div");
    contentPane.appendChild(contentChild);
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarClosedState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers);
    harness.dispatchedMessages.length = 0;

    harness.document.dispatchEvent(new TestMouseEvent("click", { target: contentChild }));
    drainTestTimers(harness.timers);

    expect(harness.dispatchedMessages).not.toContainEqual({ type: "toggle-sidebar" });
    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("does not treat full-width mobile content as open when navigation remains measurable", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "collapsed",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    const contentChild = harness.document.createElement("div");
    contentPane.appendChild(contentChild);
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarClosedState(contentPane, navigation);
    navigation.setBoundingClientRect({ left: 0, width: 240 });

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers);
    harness.dispatchedMessages.length = 0;

    harness.document.dispatchEvent(new TestMouseEvent("click", { target: contentChild }));
    drainTestTimers(harness.timers);

    expect(harness.dispatchedMessages).not.toContainEqual({ type: "toggle-sidebar" });
    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("reapplies the stored mobile sidebar mode when the shell resets after restore", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "collapsed",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarOpenState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    drainTestTimers(harness.timers, 1);
    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });

    setMobileSidebarClosedState(contentPane, navigation);
    harness.windowObject.dispatchEvent({ type: "resize" });
    drainTestTimers(harness.timers);

    setMobileSidebarOpenState(contentPane, navigation);
    harness.windowObject.dispatchEvent({ type: "resize" });
    for (let index = 0; index < 5; index += 1) {
      const toggleMessages = harness.dispatchedMessages.filter(
        (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
      );
      if (toggleMessages.length >= 2) {
        break;
      }
      drainTestTimers(harness.timers, 1);
    }

    const toggleMessages = harness.dispatchedMessages.filter(
      (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
    );
    expect(toggleMessages).toHaveLength(2);

    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
  });

  it("does not re-toggle the mobile sidebar while a restore transition is still settling", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({ mobile: true });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarOpenState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "persisted-atom-sync",
        state: {
          "pocodex-sidebar-mode": "collapsed",
        },
      },
    });

    drainTestTimers(harness.timers, 1);

    let toggleMessages = harness.dispatchedMessages.filter(
      (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
    );
    expect(toggleMessages).toHaveLength(1);

    drainTestTimers(harness.timers, 3);
    toggleMessages = harness.dispatchedMessages.filter(
      (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
    );
    expect(toggleMessages).toHaveLength(1);

    setMobileSidebarClosedState(contentPane, navigation);
    drainTestTimers(harness.timers, 3);
    toggleMessages = harness.dispatchedMessages.filter(
      (message) => JSON.stringify(message) === JSON.stringify({ type: "toggle-sidebar" }),
    );
    expect(toggleMessages).toHaveLength(1);
  });

  it("handles sidebar toggle host commands locally", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      mobile: true,
      localStorageEntries: {
        "pocodex-sidebar-mode": "expanded",
      },
    });
    const navigation = harness.document.createElement("nav");
    navigation.setAttribute("role", "navigation");
    const contentPane = harness.document.createElement("div");
    contentPane.setAttribute("class", "main-surface");
    harness.document.body.appendChild(navigation);
    harness.document.body.appendChild(contentPane);
    setMobileSidebarOpenState(contentPane, navigation);

    harness.run(script);
    await flushBootstrapMicrotasks();
    harness.openSocket();
    drainTestTimers(harness.timers);
    const sentBefore = harness.getSentEnvelopes().length;

    await harness.getElectronBridge().sendMessageFromView({
      type: "toggle-sidebar",
    });
    setMobileSidebarClosedState(contentPane, navigation);
    harness.windowObject.dispatchEvent({ type: "resize" });
    drainTestTimers(harness.timers);

    expect(harness.dispatchedMessages).toContainEqual({ type: "toggle-sidebar" });
    expect(harness.getLocalStorageValue("pocodex-sidebar-mode")).toBe("collapsed");
    expect(harness.getSentEnvelopes()).toHaveLength(sentBefore);
  });

  it("stores the active local thread in the thread query param", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&foo=bar",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    await harness.getElectronBridge().sendMessageFromView({
      type: "thread-role-request",
      conversationId: "thr_123",
    });

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.pathname).toBe("/");
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("foo")).toBe("bar");
    expect(currentUrl.searchParams.get("thread")).toBe("thr_123");
    expect(currentUrl.searchParams.get("initialRoute")).toBeNull();
    expect(harness.replaceStateCalls).toHaveLength(1);
  });

  it("updates the thread query param for local navigate-to-route messages", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "navigate-to-route",
        path: "/local/thr_456",
      },
    });

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.pathname).toBe("/");
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBe("thr_456");
    expect(currentUrl.searchParams.get("initialRoute")).toBeNull();
  });

  it("clears the thread query param for new-chat messages", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=thr_123",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "new-chat",
      },
    });

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBeNull();
  });

  it("keeps pending thread restores intact for home placeholder conversation ids", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=thr_123",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    await harness.getElectronBridge().sendMessageFromView({
      type: "thread-role-request",
      conversationId: "home:local:/root/repos/xigbclutchix/pocodex",
    });

    let currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBe("thr_123");

    await harness.getElectronBridge().sendMessageFromView({
      type: "ready",
    });
    drainTestTimers(harness.timers);

    currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.searchParams.get("thread")).toBe("thr_123");
    expect(harness.dispatchedMessages).toContainEqual({
      type: "navigate-to-route",
      path: "/local/thr_123",
    });
    expect(harness.dispatchedMessages).toContainEqual({
      type: "thread-stream-resume-request",
      hostId: "local",
      conversationId: "thr_123",
    });
  });

  it("clears the thread query param when clicking a new-thread control", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=thr_123",
    });
    const nav = harness.document.createElement("nav");
    nav.setAttribute("role", "navigation");
    const newThreadButton = harness.document.createElement("button");
    newThreadButton.textContent = "New thread";
    nav.appendChild(newThreadButton);
    harness.document.body.appendChild(nav);

    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.document.dispatchEvent(new TestMouseEvent("click", { target: newThreadButton }));
    drainTestTimers(harness.timers);

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBeNull();
  });

  it("dispatches a single local-thread restore sequence after ready for a thread query param", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=thr_123",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    await harness.getElectronBridge().sendMessageFromView({
      type: "ready",
    });
    drainTestTimers(harness.timers);

    await harness.getElectronBridge().sendMessageFromView({
      type: "ready",
    });
    drainTestTimers(harness.timers);

    const navigateMessages = harness.dispatchedMessages.filter(
      (message) =>
        JSON.stringify(message) ===
        JSON.stringify({
          type: "navigate-to-route",
          path: "/local/thr_123",
        }),
    );
    const resumeRequests = harness.dispatchedMessages.filter(
      (message) =>
        JSON.stringify(message) ===
        JSON.stringify({
          type: "thread-stream-resume-request",
          hostId: "local",
          conversationId: "thr_123",
        }),
    );

    expect(navigateMessages).toHaveLength(1);
    expect(resumeRequests).toHaveLength(1);
  });

  it("replays the local-thread restore sequence after a websocket reconnect", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=thr_123",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    const firstSocket = TestWebSocket.latest;
    expect(firstSocket).toBeTruthy();

    harness.openSocket();
    await flushBootstrapMicrotasks();

    await harness.getElectronBridge().sendMessageFromView({
      type: "ready",
    });
    drainTestTimers(harness.timers);
    await flushBootstrapMicrotasks();

    firstSocket?.emit("close", {
      code: 4000,
      reason: "heartbeat-timeout",
    });
    drainTestTimers(harness.timers);
    await flushBootstrapMicrotasks();

    const secondSocket = TestWebSocket.latest;
    expect(secondSocket).not.toBe(firstSocket);

    harness.openSocket();
    await flushBootstrapMicrotasks();
    drainTestTimers(harness.timers);
    await flushBootstrapMicrotasks();

    const navigateMessages = harness.dispatchedMessages.filter(
      (message) =>
        JSON.stringify(message) ===
        JSON.stringify({
          type: "navigate-to-route",
          path: "/local/thr_123",
        }),
    );
    const resumeRequests = harness.dispatchedMessages.filter(
      (message) =>
        JSON.stringify(message) ===
        JSON.stringify({
          type: "thread-stream-resume-request",
          hostId: "local",
          conversationId: "thr_123",
        }),
    );

    expect(navigateMessages).toHaveLength(2);
    expect(resumeRequests).toHaveLength(2);
    expect(harness.getSentEnvelopes()).toContainEqual({
      type: "bridge_message",
      message: {
        type: "ready",
      },
    });
  });

  it("replays live terminal attachments after a websocket reconnect", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    const firstSocket = TestWebSocket.latest;
    expect(firstSocket).toBeTruthy();

    harness.openSocket();
    await flushBootstrapMicrotasks();

    await harness.getElectronBridge().sendMessageFromView({
      type: "terminal-attach",
      sessionId: "term-1",
      conversationId: "conv-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
    });
    await harness.getElectronBridge().sendMessageFromView({
      type: "terminal-resize",
      sessionId: "term-1",
      cols: 132,
      rows: 40,
    });

    firstSocket?.emit("close", {
      code: 4000,
      reason: "heartbeat-timeout",
    });
    drainTestTimers(harness.timers);
    await flushBootstrapMicrotasks();

    const secondSocket = TestWebSocket.latest;
    expect(secondSocket).not.toBe(firstSocket);

    harness.openSocket();
    await flushBootstrapMicrotasks();

    expect(harness.getSentEnvelopes()).toContainEqual({
      type: "bridge_message",
      message: {
        type: "terminal-attach",
        sessionId: "term-1",
        conversationId: "conv-1",
        cwd: "/tmp/project",
        cols: 132,
        rows: 40,
      },
    });
  });

  it("does not dispatch thread restore messages without a thread query param", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const cases = [
      "http://127.0.0.1:8787/?token=secret",
      "http://127.0.0.1:8787/?token=secret&thread=",
      "http://127.0.0.1:8787/?token=secret&thread=home%3Alocal%3A%2Froot%2Frepos%2Fxigbclutchix%2Fpocodex",
      "http://127.0.0.1:8787/?token=secret&initialRoute=%2Fremote%2Ftask-1",
    ];

    for (const href of cases) {
      const harness = createBootstrapHarness({ href });
      harness.run(script);
      await flushBootstrapMicrotasks();

      await harness.getElectronBridge().sendMessageFromView({
        type: "ready",
      });
      drainTestTimers(harness.timers);

      expect(
        harness.dispatchedMessages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            ((message as { type?: unknown }).type === "thread-stream-resume-request" ||
              (message as { type?: unknown }).type === "navigate-to-route"),
        ),
      ).toBe(false);
    }
  });

  it("clears the thread query param for non-local navigate-to-route messages", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=thr_123",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "navigate-to-route",
        path: "/settings",
      },
    });

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBeNull();
  });

  it("avoids duplicate history writes for repeated active-thread sync messages", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    await harness.getElectronBridge().sendMessageFromView({
      type: "thread-role-request",
      conversationId: "thr_123",
    });
    await harness.getElectronBridge().sendMessageFromView({
      type: "thread-role-request",
      conversationId: "thr_123",
    });

    expect(harness.replaceStateCalls).toHaveLength(1);
  });

  it("migrates legacy initialRoute thread urls onto the thread query param", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&initialRoute=%2Flocal%2Fthr_legacy",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.pathname).toBe("/");
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBe("thr_legacy");
    expect(currentUrl.searchParams.get("initialRoute")).toBeNull();
  });

  it("preserves non-local legacy initialRoute urls during normalization", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&initialRoute=%2Fremote%2Ftask-1",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.pathname).toBe("/");
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBeNull();
    expect(currentUrl.searchParams.get("initialRoute")).toBe("/remote/task-1");
    expect(harness.replaceStateCalls).toHaveLength(0);
  });

  it("drops invalid thread params without deleting non-local initialRoute urls", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness({
      href: "http://127.0.0.1:8787/?token=secret&thread=home%3Alocal%3A%2Froot%2Frepos%2Fxigbclutchix%2Fpocodex&initialRoute=%2Fremote%2Ftask-1",
    });
    harness.run(script);
    await flushBootstrapMicrotasks();

    const currentUrl = new URL(harness.windowObject.location.href);
    expect(currentUrl.pathname).toBe("/");
    expect(currentUrl.searchParams.get("token")).toBe("secret");
    expect(currentUrl.searchParams.get("thread")).toBeNull();
    expect(currentUrl.searchParams.get("initialRoute")).toBe("/remote/task-1");
    expect(harness.replaceStateCalls).toHaveLength(1);
  });

  it("opens the workspace root picker from bridge messages and confirms the current folder", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const ipcRequests: Array<{ method: string; params: unknown }> = [];
    harness.setFetchHandler(async (input, init) => {
      const body = readBootstrapFetchBody({ input, init });
      if (!body) {
        return createBootstrapJsonResponse({});
      }

      const payload = JSON.parse(body) as {
        method?: string;
        params?: {
          path?: string;
          context?: string;
        };
      };
      if (typeof payload.method !== "string") {
        return createBootstrapJsonResponse({});
      }
      ipcRequests.push({
        method: payload.method,
        params: payload.params,
      });

      if (payload.method === "workspace-root-picker/list") {
        const requestedPath = payload.params?.path;
        if (requestedPath === "/remote/home/project-a") {
          return createBootstrapJsonResponse({
            resultType: "success",
            result: {
              currentPath: "/remote/home/project-a",
              parentPath: "/remote/home",
              homePath: "/remote/home",
              entries: [],
            },
          });
        }

        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            currentPath: "/remote/home",
            parentPath: "/remote",
            homePath: "/remote/home",
            entries: [
              {
                name: "project-a",
                path: "/remote/home/project-a",
              },
            ],
          },
        });
      }

      if (payload.method === "workspace-root-picker/confirm") {
        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            action: "added",
            root: "/remote/home/project-a",
          },
        });
      }

      return createBootstrapJsonResponse({});
    });

    harness.run(script);
    await flushBootstrapMicrotasks();

    expect(script).not.toContain("Import from Codex.app");

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "pocodex-open-workspace-root-picker",
        context: "manual",
        initialPath: "/remote/home",
      },
    });
    await flushBootstrapMicrotasks();

    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-dialog="true"]'),
    ).toBeTruthy();
    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/list",
      params: {
        path: "/remote/home",
      },
    });
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-home-button="true"]'),
    ).toBeNull();
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-up-button="true"]'),
    ).toBeNull();

    const parentRow = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-parent-row="true"]',
    );
    expect(parentRow?.textContent).toBe("..");

    const rows = harness.document.querySelectorAll(
      'button[data-pocodex-workspace-root-picker-row="true"]',
    );
    expect(rows.length).toBe(2);
    const row = rows.item(1);
    expect(row?.textContent).toBe("project-a");
    row?.dispatchEvent(new TestMouseEvent("click", { target: row }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/list",
      params: {
        path: "/remote/home/project-a",
      },
    });
    const currentPathInput = harness.document.querySelector(
      'input[data-pocodex-workspace-root-picker-path-input="true"]',
    );
    expect(currentPathInput?.value).toBe("/remote/home/project-a");

    const useFolderButton = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-use-folder-button="true"]',
    );
    expect(useFolderButton).toBeTruthy();
    useFolderButton?.dispatchEvent(new TestMouseEvent("click", { target: useFolderButton }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/confirm",
      params: {
        path: "/remote/home/project-a",
        context: "manual",
      },
    });
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-dialog="true"]'),
    ).toBeNull();

    const toast = harness.document.querySelector('[data-pocodex-toast="true"]');
    expect(toast?.textContent).toBe("Added project folder.");
  });

  it("supports manual path entry and new-folder creation in the workspace root picker", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const ipcRequests: Array<{ method: string; params: unknown }> = [];
    harness.setFetchHandler(async (input, init) => {
      const body = readBootstrapFetchBody({ input, init });
      if (!body) {
        return createBootstrapJsonResponse({});
      }

      const payload = JSON.parse(body) as {
        method?: string;
        params?: {
          path?: string;
          parentPath?: string;
          name?: string;
        };
      };
      if (typeof payload.method !== "string") {
        return createBootstrapJsonResponse({});
      }
      ipcRequests.push({
        method: payload.method,
        params: payload.params,
      });

      if (payload.method === "workspace-root-picker/list") {
        const requestedPath = payload.params?.path;
        if (requestedPath === "~/manual-project") {
          return createBootstrapJsonResponse({
            resultType: "success",
            result: {
              currentPath: "/home/tester/manual-project",
              parentPath: "/home/tester",
              homePath: "/home/tester",
              entries: [],
            },
          });
        }
        if (requestedPath === "/home/tester/manual-project/child") {
          return createBootstrapJsonResponse({
            resultType: "success",
            result: {
              currentPath: "/home/tester/manual-project/child",
              parentPath: "/home/tester/manual-project",
              homePath: "/home/tester",
              entries: [],
            },
          });
        }

        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            currentPath: "/home/tester",
            parentPath: "/home",
            homePath: "/home/tester",
            entries: [],
          },
        });
      }

      if (payload.method === "workspace-root-picker/create-directory") {
        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            currentPath: "/home/tester/manual-project/child",
          },
        });
      }

      return createBootstrapJsonResponse({});
    });

    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "pocodex-open-workspace-root-picker",
        context: "manual",
        initialPath: "/home/tester",
      },
    });
    await flushBootstrapMicrotasks();

    const pathInput = harness.document.querySelector(
      'input[data-pocodex-workspace-root-picker-path-input="true"]',
    );
    expect(pathInput).toBeTruthy();
    if (!pathInput) {
      throw new Error("Expected path input to exist");
    }
    pathInput.value = "~/manual-project";
    pathInput.dispatchEvent({ type: "input" });

    const openButton = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-open-button="true"]',
    );
    expect(openButton).toBeTruthy();
    openButton?.dispatchEvent(new TestMouseEvent("click", { target: openButton }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/list",
      params: {
        path: "~/manual-project",
      },
    });
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-current-path="true"]'),
    ).toBeNull();
    expect(
      harness.document.querySelector(
        '[data-pocodex-workspace-root-picker-new-folder-input="true"]',
      ),
    ).toBeNull();
    expect(
      harness.document.querySelector(
        '[data-pocodex-workspace-root-picker-create-folder-button="true"]',
      ),
    ).toBeNull();

    const loadedPathInput = harness.document.querySelector(
      'input[data-pocodex-workspace-root-picker-path-input="true"]',
    );
    expect(loadedPathInput?.value).toBe("/home/tester/manual-project");

    const newFolderButton = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-new-folder-button="true"]',
    );
    expect(newFolderButton).toBeTruthy();
    expect(newFolderButton?.disabled).toBe(true);
    if (!loadedPathInput) {
      throw new Error("Expected loaded path input to exist");
    }
    loadedPathInput.value = "/home/tester/manual-project/child";
    loadedPathInput.dispatchEvent({ type: "input" });
    expect(newFolderButton?.disabled).toBe(false);

    newFolderButton?.dispatchEvent(new TestMouseEvent("click", { target: newFolderButton }));
    await flushBootstrapMicrotasks();
    await flushBootstrapMicrotasks();

    expect(ipcRequests).toContainEqual({
      method: "workspace-root-picker/create-directory",
      params: {
        parentPath: "/home/tester/manual-project",
        name: "child",
      },
    });
    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/list",
      params: {
        path: "/home/tester/manual-project/child",
      },
    });
    const createdPathInput = harness.document.querySelector(
      'input[data-pocodex-workspace-root-picker-path-input="true"]',
    );
    expect(createdPathInput?.value).toBe("/home/tester/manual-project/child");
  });

  it("confirms the typed folder path without requiring an open round-trip first", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const ipcRequests: Array<{ method: string; params: unknown }> = [];
    harness.setFetchHandler(async (input, init) => {
      const body = readBootstrapFetchBody({ input, init });
      if (!body) {
        return createBootstrapJsonResponse({});
      }

      const payload = JSON.parse(body) as {
        method?: string;
        params?: {
          path?: string;
          context?: string;
        };
      };
      if (typeof payload.method === "string") {
        ipcRequests.push({
          method: payload.method,
          params: payload.params,
        });
      }

      if (payload.method === "workspace-root-picker/list") {
        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            currentPath: "/home/tester",
            parentPath: "/home",
            homePath: "/home/tester",
            entries: [],
          },
        });
      }

      if (payload.method === "workspace-root-picker/confirm") {
        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            action: "added",
            root: payload.params?.path ?? "",
          },
        });
      }

      return createBootstrapJsonResponse({});
    });

    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "pocodex-open-workspace-root-picker",
        context: "manual",
        initialPath: "/home/tester",
      },
    });
    await flushBootstrapMicrotasks();

    const pathInput = harness.document.querySelector(
      'input[data-pocodex-workspace-root-picker-path-input="true"]',
    );
    expect(pathInput).toBeTruthy();
    if (!pathInput) {
      throw new Error("Expected path input to exist");
    }

    pathInput.value = "/home/tester/typed-project";
    pathInput.dispatchEvent({ type: "input" });

    const useFolderButton = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-use-folder-button="true"]',
    );
    expect(useFolderButton?.disabled).toBe(false);
    useFolderButton?.dispatchEvent(new TestMouseEvent("click", { target: useFolderButton }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/confirm",
      params: {
        path: "/home/tester/typed-project",
        context: "manual",
      },
    });
  });

  it("keeps onboarding open until a folder has loaded and shows cancel errors inline", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const ipcRequests: Array<{ method: string; params: unknown }> = [];
    let resolveInitialList: ((response: TestResponse) => void) | null = null;
    harness.setFetchHandler(async (input, init) => {
      const body = readBootstrapFetchBody({ input, init });
      if (!body) {
        return createBootstrapJsonResponse({});
      }

      const payload = JSON.parse(body) as {
        method?: string;
        params?: {
          path?: string;
          context?: string;
        };
      };
      if (typeof payload.method === "string") {
        ipcRequests.push({
          method: payload.method,
          params: payload.params,
        });
      }

      if (payload.method === "workspace-root-picker/list") {
        return await new Promise<TestResponse>((resolve) => {
          resolveInitialList = resolve;
        });
      }

      if (payload.method === "workspace-root-picker/cancel") {
        return createBootstrapJsonResponse({
          resultType: "error",
          error: "cancel failed",
        });
      }

      return createBootstrapJsonResponse({});
    });

    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "pocodex-open-workspace-root-picker",
        context: "onboarding",
        initialPath: "/home/tester",
      },
    });
    await flushBootstrapMicrotasks();

    const backdrop = harness.document.querySelector(
      '[data-pocodex-workspace-root-picker-backdrop="true"]',
    );
    expect(backdrop).toBeTruthy();
    backdrop?.dispatchEvent(new TestMouseEvent("click", { target: backdrop }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests).toEqual([
      {
        method: "workspace-root-picker/list",
        params: {
          path: "/home/tester",
        },
      },
    ]);
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-dialog="true"]'),
    ).toBeTruthy();

    resolveInitialList?.(
      createBootstrapJsonResponse({
        resultType: "success",
        result: {
          currentPath: "/home/tester",
          parentPath: "/home",
          homePath: "/home/tester",
          entries: [],
        },
      }),
    );
    await flushBootstrapMicrotasks();
    await flushBootstrapMicrotasks();

    const cancelButton = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-cancel-button="true"]',
    );
    expect(cancelButton?.disabled).toBe(false);
    cancelButton?.dispatchEvent(new TestMouseEvent("click", { target: cancelButton }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/cancel",
      params: {
        context: "onboarding",
      },
    });
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-dialog="true"]'),
    ).toBeTruthy();
    const errorText = harness.document.querySelector(
      '[data-pocodex-workspace-root-picker-error="true"]',
    );
    expect(errorText?.textContent).toBe("cancel failed");
  });

  it("cancels onboarding picker sessions through IPC", async () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
    });

    const harness = createBootstrapHarness();
    const ipcRequests: Array<{ method: string; params: unknown }> = [];
    harness.setFetchHandler(async (input, init) => {
      const body = readBootstrapFetchBody({ input, init });
      if (!body) {
        return createBootstrapJsonResponse({});
      }

      const payload = JSON.parse(body) as {
        method?: string;
        params?: {
          context?: string;
        };
      };
      if (typeof payload.method === "string") {
        ipcRequests.push({
          method: payload.method,
          params: payload.params,
        });
      }

      if (payload.method === "workspace-root-picker/list") {
        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            currentPath: "/home/tester",
            parentPath: "/home",
            homePath: "/home/tester",
            entries: [],
          },
        });
      }

      if (payload.method === "workspace-root-picker/cancel") {
        return createBootstrapJsonResponse({
          resultType: "success",
          result: {
            cancelled: true,
          },
        });
      }

      return createBootstrapJsonResponse({});
    });

    harness.run(script);
    await flushBootstrapMicrotasks();

    harness.emitServerEnvelope({
      type: "bridge_message",
      message: {
        type: "pocodex-open-workspace-root-picker",
        context: "onboarding",
        initialPath: "/home/tester",
      },
    });
    await flushBootstrapMicrotasks();

    const cancelButton = harness.document.querySelector(
      'button[data-pocodex-workspace-root-picker-cancel-button="true"]',
    );
    expect(cancelButton).toBeTruthy();
    cancelButton?.dispatchEvent(new TestMouseEvent("click", { target: cancelButton }));
    await flushBootstrapMicrotasks();

    expect(ipcRequests.at(-1)).toEqual({
      method: "workspace-root-picker/cancel",
      params: {
        context: "onboarding",
      },
    });
    expect(
      harness.document.querySelector('[data-pocodex-workspace-root-picker-dialog="true"]'),
    ).toBeNull();
  });

  it("includes the host workspace-root shim in the bootstrap", () => {
    const script = renderBootstrapScript({
      sentryOptions: {
        buildFlavor: "stable",
        appVersion: "1",
        buildNumber: "123",
        codexAppSessionId: "session-id",
      },
      stylesheetHref: "/pocodex.css",
      importIconSvg: '<svg viewBox="0 0 1 1"></svg>',
    });

    expect(script).toContain("pocodex-open-workspace-root-dialog");
    expect(script).toContain("workspace-root-browser/list");
    expect(script).toContain("workspace-root-option/add");
    expect(script).toContain("workspace-root-option-added");
    expect(script).toContain("workspace-root-option-picked");
  });
});
