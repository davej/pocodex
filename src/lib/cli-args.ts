export function normalizeCliArgv(argv: readonly string[]): string[] {
  const normalized = [...argv];

  while (normalized[0] === "--") {
    normalized.shift();
  }

  if (normalized[0] === "serve") {
    while (normalized[1] === "--") {
      normalized.splice(1, 1);
    }
  }

  return normalized;
}
