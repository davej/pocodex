import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trayDirectory = join(scriptDirectory, "..");
const rootDirectory = join(trayDirectory, "..", "..");
const assetsDirectory = join(trayDirectory, "assets");
const trayTemplateSourcePath = resolveBundledSource(
  join(assetsDirectory, "tray-template-source.png"),
  join(rootDirectory, "artifacts", "pocodex-template-image.png"),
);
const appIconSourcePath = resolveBundledSource(
  join(assetsDirectory, "app-icon-source.png"),
  join(rootDirectory, "artifacts", "icon.png"),
);
const appIconSizes = [128, 256, 512];
const trayIconSizes = [16, 18, 20, 24, 32, 36, 40];

mkdirSync(assetsDirectory, { recursive: true });

for (const size of trayIconSizes) {
  execFileSync(
    "/usr/bin/sips",
    [
      "-z",
      String(size),
      String(size),
      trayTemplateSourcePath,
      "--out",
      join(assetsDirectory, `tray-template-${size}.png`),
    ],
    { stdio: "ignore" },
  );
}

for (const size of appIconSizes) {
  execFileSync(
    "/usr/bin/sips",
    [
      "-z",
      String(size),
      String(size),
      appIconSourcePath,
      "--out",
      join(assetsDirectory, `app-icon-${size}.png`),
    ],
    { stdio: "ignore" },
  );
}

copyFileSync(join(assetsDirectory, "app-icon-512.png"), join(assetsDirectory, "app-icon.png"));
copyFileSync(
  join(assetsDirectory, "tray-template-18.png"),
  join(assetsDirectory, "tray-template.png"),
);
copyFileSync(
  join(assetsDirectory, "tray-template-36.png"),
  join(assetsDirectory, "tray-template@2x.png"),
);

function resolveBundledSource(localSourcePath, fallbackSourcePath) {
  if (existsSync(localSourcePath)) {
    return localSourcePath;
  }

  if (existsSync(fallbackSourcePath)) {
    copyFileSync(fallbackSourcePath, localSourcePath);
    return localSourcePath;
  }

  throw new Error(`Missing tray asset source: ${localSourcePath}`);
}
