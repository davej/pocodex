export interface ListenAddress {
  listenHost: string;
  listenPort: number;
}

export function parseListenAddress(value: string): ListenAddress | null {
  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  const listenHost = value.slice(0, separatorIndex);
  const listenPort = Number.parseInt(value.slice(separatorIndex + 1), 10);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    return null;
  }

  return {
    listenHost,
    listenPort,
  };
}
