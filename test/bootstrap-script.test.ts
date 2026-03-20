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
  style: Record<string, string> = {};
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

function createBootstrapHarness(
  options: {
    href?: string;
    mobile?: boolean;
  } = {},
) {
  const href = options.href ?? "http://127.0.0.1:8787/?token=secret";
  const storage = new Map<string, string>();
  const timers = new Map<number, () => void>();
  const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
  const dispatchedMessages: unknown[] = [];
  const replaceStateCalls: Array<string | URL | null | undefined> = [];
  let nextTimerId = 1;

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
    return { ok: true, status: 200 };
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
    sessionStorage: {
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      getItem: (key: string) => storage.get(key) ?? null,
    },
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

  it("forces multiline enter behavior for mobile sessions without changing the host state", async () => {
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
    };

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
      matches: query.includes("max-width"),
      media: query,
    });

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

    socket?.emit("message", {
      data: JSON.stringify({
        type: "bridge_message",
        message: {
          type: "persisted-atom-sync",
          state: {
            "enter-behavior": "enter",
            "agent-mode": "auto",
          },
        },
      }),
    });

    socket?.emit("message", {
      data: JSON.stringify({
        type: "bridge_message",
        message: {
          type: "persisted-atom-updated",
          key: "enter-behavior",
          value: "enter",
        },
      }),
    });

    expect(dispatchedMessages).toContainEqual({
      type: "persisted-atom-sync",
      state: {
        "enter-behavior": "newline",
        "agent-mode": "auto",
      },
    });
    expect(dispatchedMessages).toContainEqual({
      type: "persisted-atom-updated",
      key: "enter-behavior",
      value: "newline",
      deleted: false,
    });
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
    expect(script).toMatch(/root\.textContent\s*=\s*formatDesktopImportPath\(project\.root\)/);
    expect(script).toMatch(/\^\\\/\(\?:users\|home\)\\\/\[\^\/\]\+\(\?=\\\/\|\$\)\/i/);
    expect(script).toMatch(
      /trimmedPath\.replace\(\s*\/\^\\\/\(\?:users\|home\)\\\/\[\^\/\]\+\(\?=\\\/\|\$\)\/i,\s*"~"\s*\)/,
    );
  });
});
