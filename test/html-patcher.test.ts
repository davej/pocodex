import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { patchIndexHtml } from "../src/lib/html-patcher.js";

describe("patchIndexHtml", () => {
  it("injects the bootstrap before the entry script and adds its CSP hash", () => {
    const html = `<!doctype html>
<html>
  <head>
    <script type="module" crossorigin src="./assets/index.js"></script>
    <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39;; style-src &#39;self&#39;;">
  </head>
</html>`;

    const bootstrapScript = "window.__POCODEX__ = true;";
    const patched = patchIndexHtml(html, {
      bootstrapScript,
      faviconHref: "./assets/app.png",
      headTags: [`<link rel="manifest" href="/manifest.webmanifest" id="pocodex-manifest">`],
      stylesheetHref: "/pocodex.css",
    });
    const hash = createHash("sha256").update(bootstrapScript).digest("base64");

    expect(patched).toContain(`<script>${bootstrapScript}</script>`);
    expect(patched).toContain(`<link rel="icon" href="./assets/app.png" id="pocodex-favicon">`);
    expect(patched).toContain(
      `<link rel="manifest" href="/manifest.webmanifest" id="pocodex-manifest">`,
    );
    expect(patched).toContain(
      `<link rel="stylesheet" href="/pocodex.css" id="pocodex-stylesheet">`,
    );
    expect(
      patched.indexOf(`<link rel="icon" href="./assets/app.png" id="pocodex-favicon">`),
    ).toBeLessThan(
      patched.indexOf(`<script type="module" crossorigin src="./assets/index.js"></script>`),
    );
    expect(patched.indexOf(`<script>${bootstrapScript}</script>`)).toBeLessThan(
      patched.indexOf(`<script type="module" crossorigin src="./assets/index.js"></script>`),
    );
    expect(patched).toContain(`&#39;sha256-${hash}&#39;`);
    expect(patched).toContain(`manifest-src &#39;self&#39;; worker-src &#39;self&#39;;`);
  });

  it("keeps encoded CSP quotes intact when patching shipped Codex HTML", () => {
    const html = `<!doctype html>
<html>
  <head>
    <script type="module" crossorigin src="./assets/index.js"></script>
    <meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;self&#39; &#39;wasm-unsafe-eval&#39;; style-src &#39;self&#39;;">
  </head>
</html>`;

    const bootstrapScript = "window.__POCODEX__ = true;";
    const patched = patchIndexHtml(html, { bootstrapScript, stylesheetHref: "/pocodex.css" });
    const hash = createHash("sha256").update(bootstrapScript).digest("base64");

    expect(patched).toContain(
      `script-src &#39;sha256-${hash}&#39; &#39;self&#39; &#39;wasm-unsafe-eval&#39;`,
    );
    expect(patched).toContain(`manifest-src &#39;self&#39;; worker-src &#39;self&#39;;`);
  });
});
