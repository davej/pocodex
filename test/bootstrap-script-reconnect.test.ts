import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { renderBootstrapScript } from "../src/lib/bootstrap-script.js";

describe("renderBootstrapScript reconnect behavior", () => {
  it("reconnects in place without reloading and acknowledges heartbeats", async () => {
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
      id = "";
      rel = "";
      href = "";
      textContent = "";

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

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string) {
        return createNodeList([]);
      }

      closest(_selector: string): Element | null {
        return null;
      }

      getAttribute(_name: string): string | null {
        return null;
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
        if (tagName === "div") {
          return new HTMLDivElement();
        }
        if (tagName === "link") {
          return new HTMLLinkElement();
        }
        return new Element(tagName.toUpperCase());
      }

      querySelector(_selector: string): Element | null {
        return null;
      }

      querySelectorAll(_selector: string) {
        return createNodeList([]);
      }

      getElementsByTagName(tagName: string): Element[] {
        return tagName === "head" ? [this.head] : [];
      }

      getElementById(id: string): Element | null {
        for (const child of [...this.head.children, ...this.body.children]) {
          if (child.id === id) {
            return child;
          }
        }
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

    class CloseEvent {
      constructor(
        readonly type: string,
        readonly init: { code?: number; reason?: string } = {},
      ) {}

      get code(): number {
        return this.init.code ?? 1000;
      }

      get reason(): string {
        return this.init.reason ?? "";
      }
    }

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static instances: MockWebSocket[] = [];

      readonly listeners = new Map<string, Listener[]>();
      readonly sentMessages: string[] = [];
      readyState = MockWebSocket.CONNECTING;

      constructor(readonly url: string) {
        MockWebSocket.instances.push(this);
      }

      addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
      }

      send(message: string): void {
        this.sentMessages.push(message);
      }

      close(_code?: number, _reason?: string): void {
        this.readyState = MockWebSocket.CLOSED;
      }

      emit(type: string, event: unknown = {}): void {
        const listeners = this.listeners.get(type) ?? [];
        for (const listener of listeners) {
          listener(event);
        }
      }

      open(): void {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
      }
    }

    const timers = new Map<number, () => void>();
    let nextTimerId = 1;
    const storage = new Map<string, string>();
    const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
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
      innerWidth: number;
      locationReloaded: boolean;
    };

    windowObject.location = {
      href: "http://127.0.0.1:8787/?token=secret",
      protocol: "http:",
      host: "127.0.0.1:8787",
      reload: () => {
        windowObject.locationReloaded = true;
      },
    };
    windowObject.history = {
      pushState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
      replaceState: (_data: unknown, _unused: string, _url?: string | URL | null) => {},
    };
    windowObject.fetch = async (input: unknown, init?: unknown) => {
      fetchCalls.push({ input, init });
      return { ok: true, status: 200 };
    };
    windowObject.setTimeout = (callback: () => void, _delay: number) => {
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

    const context = vm.createContext({
      window: windowObject,
      document,
      URL,
      HTMLDivElement,
      HTMLLinkElement,
      MutationObserver,
      MessageEvent,
      CloseEvent,
      Request,
      Response,
      WebSocket: MockWebSocket,
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
      Date,
      encodeURIComponent,
    });

    vm.runInContext(script, context);
    await waitFor(() => MockWebSocket.instances.length === 1);

    expect(fetchCalls[0]).toEqual({
      input: "/session-check?token=secret",
      init: {
        cache: "no-store",
        credentials: "same-origin",
      },
    });

    const firstSocket = MockWebSocket.instances[0];
    expect(firstSocket?.url).toBe("ws://127.0.0.1:8787/session?token=secret");

    firstSocket?.open();
    await flushMicrotasks();

    firstSocket?.emit("message", {
      data: JSON.stringify({
        type: "heartbeat",
        sentAt: 123,
      }),
    });

    expect(firstSocket?.sentMessages.map(parseEnvelope)).toContainEqual({
      type: "heartbeat_ack",
      sentAt: 123,
    });

    firstSocket?.emit(
      "close",
      new CloseEvent("close", { code: 4000, reason: "heartbeat-timeout" }),
    );
    await flushMicrotasks();

    runLatestTimer(timers);
    await waitFor(() => MockWebSocket.instances.length === 2);

    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket?.url).toBe("ws://127.0.0.1:8787/session?token=secret");

    secondSocket?.open();
    await flushMicrotasks();

    expect(windowObject.locationReloaded).toBe(false);
    expect(fetchCalls).toContainEqual({
      input: "/session-check?token=secret",
      init: {
        cache: "no-store",
        credentials: "same-origin",
      },
    });
  });
});

function createNodeList<T>(values: T[]): {
  length: number;
  item(index: number): T | null;
  forEach(callback: (value: T, key: number, parent: unknown) => void): void;
} {
  return {
    length: values.length,
    item: (index: number) => values[index] ?? null,
    forEach: (callback: (value: T, key: number, parent: unknown) => void) => {
      values.forEach((value, index) => callback(value, index, values));
    },
  };
}

function runLatestTimer(timers: Map<number, () => void>): void {
  const latestId = [...timers.keys()].sort((left, right) => right - left)[0];
  if (latestId === undefined) {
    throw new Error("Expected a scheduled timer");
  }

  const callback = timers.get(latestId);
  timers.delete(latestId);
  callback?.();
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Condition did not become true in time");
    }
    await flushMicrotasks();
  }
}

function parseEnvelope(serialized: string): unknown {
  return JSON.parse(serialized);
}
