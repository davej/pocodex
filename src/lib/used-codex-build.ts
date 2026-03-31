import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { deriveCodexHomePath } from "./codex-home.js";

export interface CodexBuildSignature {
  version: string;
  buildFlavor: string;
  buildNumber: string;
}

export interface RecordedCodexBuildState {
  currentBuild: CodexBuildSignature;
  previousBuild: CodexBuildSignature | null;
  isUpdated: boolean;
}

interface PersistedCodexBuildRecord {
  schemaVersion: number;
  codexBuild: CodexBuildSignature;
}

export function deriveLastUsedCodexBuildPath(): string {
  return join(deriveCodexHomePath(), "pocodex", "last-used-codex-build.json");
}

export async function recordUsedCodexBuild(
  registryPath: string,
  currentBuild: CodexBuildSignature,
): Promise<RecordedCodexBuildState> {
  const previousBuild = await loadStoredCodexBuild(registryPath);
  const isUpdated = previousBuild ? isCodexBuildNewer(currentBuild, previousBuild) : false;

  if (!previousBuild || hasCodexBuildChanged(previousBuild, currentBuild)) {
    await saveStoredCodexBuild(registryPath, currentBuild);
  }

  return {
    currentBuild,
    previousBuild,
    isUpdated,
  };
}

export function formatCodexBuildSignature(build: CodexBuildSignature): string {
  const flavorText = build.buildFlavor ? `${build.buildFlavor} ` : "";
  const buildNumberText = build.buildNumber ? `build ${build.buildNumber}` : "build unknown";
  return `${build.version} (${flavorText}${buildNumberText})`;
}

async function loadStoredCodexBuild(registryPath: string): Promise<CodexBuildSignature | null> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  return parseStoredCodexBuild(raw);
}

async function saveStoredCodexBuild(
  registryPath: string,
  currentBuild: CodexBuildSignature,
): Promise<void> {
  const payload: PersistedCodexBuildRecord = {
    schemaVersion: 1,
    codexBuild: currentBuild,
  };

  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseStoredCodexBuild(raw: string): CodexBuildSignature | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.codexBuild)) {
    return null;
  }

  const { version, buildFlavor, buildNumber } = parsed.codexBuild;
  if (
    typeof version !== "string" ||
    typeof buildFlavor !== "string" ||
    typeof buildNumber !== "string"
  ) {
    return null;
  }

  return {
    version,
    buildFlavor,
    buildNumber,
  };
}

function hasCodexBuildChanged(left: CodexBuildSignature, right: CodexBuildSignature): boolean {
  return (
    left.version !== right.version ||
    left.buildFlavor !== right.buildFlavor ||
    left.buildNumber !== right.buildNumber
  );
}

function isCodexBuildNewer(currentBuild: CodexBuildSignature, previousBuild: CodexBuildSignature) {
  const versionComparison = compareNumericVersionLikeValues(
    currentBuild.version,
    previousBuild.version,
  );
  if (versionComparison !== 0) {
    return versionComparison > 0;
  }

  const buildNumberComparison = compareNumericVersionLikeValues(
    currentBuild.buildNumber,
    previousBuild.buildNumber,
  );
  if (buildNumberComparison !== 0) {
    return buildNumberComparison > 0;
  }

  return false;
}

function compareNumericVersionLikeValues(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const leftParts = parseNumericVersionLikeValue(left);
  const rightParts = parseNumericVersionLikeValue(right);
  if (!leftParts || !rightParts) {
    return 0;
  }

  const partCount = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function parseNumericVersionLikeValue(value: string): number[] | null {
  const trimmedValue = value.trim();
  if (!/^\d+(?:\.\d+)*$/.test(trimmedValue)) {
    return null;
  }

  return trimmedValue.split(".").map((part) => Number.parseInt(part, 10));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
