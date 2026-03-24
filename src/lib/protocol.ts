export interface SentryInitOptions {
  buildFlavor: string;
  appVersion: string;
  buildNumber: string;
  codexAppSessionId: string;
}

export interface ServeCommandOptions {
  appPath: string;
  appServerPath?: string;
  appServerYolo: boolean;
  devMode: boolean;
  listenHost: string;
  listenPort: number;
  token: string;
}

export interface PocodexServerOptions {
  listenHost: string;
  listenPort: number;
  token: string;
  relay: HostBridge;
  webviewRoot: string;
  readPocodexStylesheet: () => Promise<string>;
  renderIndexHtml: () => Promise<string>;
}

export interface HostBridge {
  on(event: "bridge_message", listener: (message: unknown) => void): this;
  on(event: "worker_message", listener: (workerName: string, message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(): Promise<void>;
  forwardBridgeMessage(message: unknown): Promise<void>;
  sendWorkerMessage(workerName: string, message: unknown): Promise<void>;
  subscribeWorker(workerName: string): Promise<void>;
  unsubscribeWorker(workerName: string): Promise<void>;
  handleIpcRequest?(payload: unknown): Promise<unknown>;
}

export interface JsonRecord {
  [key: string]: unknown;
}

export interface BrowserBridgeEnvelope {
  type: "bridge_message";
  message: unknown;
}

export interface BrowserWorkerSubscribeEnvelope {
  type: "worker_subscribe";
  workerName: string;
}

export interface BrowserWorkerUnsubscribeEnvelope {
  type: "worker_unsubscribe";
  workerName: string;
}

export interface BrowserWorkerMessageEnvelope {
  type: "worker_message";
  workerName: string;
  message: unknown;
}

export interface BrowserFocusStateEnvelope {
  type: "focus_state";
  isFocused: boolean;
}

export type BrowserToServerEnvelope =
  | BrowserBridgeEnvelope
  | BrowserWorkerSubscribeEnvelope
  | BrowserWorkerUnsubscribeEnvelope
  | BrowserWorkerMessageEnvelope
  | BrowserFocusStateEnvelope;

export interface ServerBridgeEnvelope {
  type: "bridge_message";
  message: unknown;
}

export interface ServerWorkerMessageEnvelope {
  type: "worker_message";
  workerName: string;
  message: unknown;
}

export interface ServerClientNoticeEnvelope {
  type: "client_notice";
  message: string;
}

export interface ServerCssReloadEnvelope {
  type: "css_reload";
  href: string;
}

export interface ServerSessionRevokedEnvelope {
  type: "session_revoked";
  reason: string;
}

export interface ServerErrorEnvelope {
  type: "error";
  message: string;
}

export type ServerToBrowserEnvelope =
  | ServerBridgeEnvelope
  | ServerWorkerMessageEnvelope
  | ServerClientNoticeEnvelope
  | ServerCssReloadEnvelope
  | ServerSessionRevokedEnvelope
  | ServerErrorEnvelope;

export interface HostMessageRouteResult {
  deliver: boolean;
  sessionId?: string;
  message?: unknown;
}
