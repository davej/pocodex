import type { PocodexSnapshot } from "pocodex";

export function getClipboardUrl(
  snapshot: PocodexSnapshot,
  target: "local" | "network",
): string | null {
  if (target === "local") {
    return snapshot.localOpenUrl ?? snapshot.localUrl;
  }

  return snapshot.networkOpenUrl ?? snapshot.networkUrl ?? null;
}
