import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trayDirectory = join(scriptDirectory, "..");
const requireFromTray = createRequire(join(trayDirectory, "package.json"));
const pocodexPackageJsonPath = requireFromTray.resolve("pocodex/package.json");
const pocodexDirectory = dirname(pocodexPackageJsonPath);
const pocodexDistDirectory = join(pocodexDirectory, "dist");
const pocodexEntryPath = join(pocodexDistDirectory, "index.js");
const pocodexStylesheetPath = join(pocodexDistDirectory, "pocodex.css");
const pocodexStaticImagePath = join(pocodexDistDirectory, "images", "import.svg");
const pocodexTsconfigPath = join(pocodexDirectory, "tsconfig.json");

if (
  existsSync(pocodexEntryPath) &&
  existsSync(pocodexStylesheetPath) &&
  existsSync(pocodexStaticImagePath)
) {
  process.exit(0);
}

if (!existsSync(pocodexTsconfigPath)) {
  throw new Error(
    `Missing bundled Pocodex build output at ${pocodexEntryPath} and no source checkout at ${pocodexTsconfigPath}.`,
  );
}

await runCommand(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
  "exec",
  "tsgo",
  "-p",
  pocodexTsconfigPath,
]);

mkdirSync(join(pocodexDistDirectory, "images"), { recursive: true });
copyFileSync(
  join(pocodexDirectory, "src", "pocodex.css"),
  join(pocodexDistDirectory, "pocodex.css"),
);
copyFileSync(
  join(pocodexDirectory, "src", "images", "import.svg"),
  join(pocodexDistDirectory, "images", "import.svg"),
);

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: trayDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}`));
    });
  });
}
