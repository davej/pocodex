export function shouldInitTodesktopRuntime(options: {
  enableRuntimeEnv: string | undefined;
  isPackaged: boolean;
  smokeTestEnv: string | undefined;
}): boolean {
  if (options.isPackaged) {
    return true;
  }

  return isTruthyEnvValue(options.enableRuntimeEnv) && isTruthyEnvValue(options.smokeTestEnv);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true";
}
