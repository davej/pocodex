import { createHash } from "node:crypto";

export function patchIndexHtml(
  html: string,
  options: {
    bootstrapScript: string;
    faviconHref?: string | null;
    headTags?: string[];
    stylesheetHref: string;
  },
): string {
  const faviconTag = options.faviconHref
    ? `<link rel="icon" href="${options.faviconHref}" id="pocodex-favicon">`
    : "";
  const stylesheetTag = `<link rel="stylesheet" href="${options.stylesheetHref}" id="pocodex-stylesheet">`;
  const bootstrapTag = `<script>${options.bootstrapScript}</script>`;
  const withBootstrap = html.replace(
    /(\s*)(<script type="module"\s+crossorigin\s+src="\.[^"]+"><\/script>)/,
    (_match, indentation, entryScript) =>
      [
        faviconTag ? `${indentation}${faviconTag}` : "",
        ...(options.headTags ?? []).map((tag) => `${indentation}${tag}`),
        `${indentation}${stylesheetTag}`,
        `${indentation}${bootstrapTag}`,
        `${indentation}${entryScript}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
  );

  if (withBootstrap === html) {
    throw new Error("Unable to locate the Codex entry script in index.html");
  }

  const hash = createHash("sha256").update(options.bootstrapScript).digest("base64");
  const encodedHash = `&#39;sha256-${hash}&#39;`;
  const withCsp = withBootstrap.includes("script-src &#39;self&#39;")
    ? withBootstrap.replace("script-src &#39;self&#39;", `script-src ${encodedHash} &#39;self&#39;`)
    : withBootstrap.replace(/script-src\s+'self'/, `script-src '${`sha256-${hash}`}' 'self'`);

  if (withCsp === withBootstrap) {
    throw new Error("Unable to update the Codex content security policy");
  }

  return ensurePwaCspDirectives(withCsp);
}

function ensurePwaCspDirectives(html: string): string {
  const quotedSelf = html.includes("&#39;self&#39;") ? "&#39;self&#39;" : "'self'";
  const withManifestSrc = ensureCspDirective(html, "manifest-src", quotedSelf);
  return ensureCspDirective(withManifestSrc, "worker-src", quotedSelf);
}

function ensureCspDirective(html: string, directive: string, value: string): string {
  if (html.includes(`${directive} ${value}`)) {
    return html;
  }

  const styleDirectivePattern = new RegExp(`style-src\\s+${escapeRegExp(value)}`);
  const withDirective = html.replace(
    styleDirectivePattern,
    `${directive} ${value}; style-src ${value}`,
  );

  if (withDirective === html) {
    throw new Error(`Unable to add ${directive} to the Codex content security policy`);
  }

  return withDirective;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
