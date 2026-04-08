import { logoMarkup } from "./logo";

const githubLatestReleaseUrl = "https://api.github.com/repos/davej/pocodex/releases/latest";
const releaseCachePath = "/api/latest-release";
const releaseCacheTtlSeconds = 300;
const releasesPageUrl = "https://github.com/davej/pocodex/releases";
const releaseNotesBoilerplate = `--
- Install CLI with \`npm i -g pocodex\`
- Download desktop app at https://www.pocodex.app/`;

type GitHubRelease = {
  body: string | null;
  html_url: string;
  name: string | null;
  published_at: string | null;
  tag_name: string;
};

type LatestReleasePayload = {
  htmlUrl: string;
  name: string;
  notesHtml: string;
  publishedAt: string | null;
  publishedLabel: string;
  tagName: string;
  version: string;
};

type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

function renderPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pocodex</title>
    <link rel="icon" href="/favicon.png" type="image/png">
    <meta
      name="description"
      content="Pocodex brings Codex.app to the browser. Download the desktop app or view the project on GitHub."
    >
    <style>
      :root {
        --paper: #f8efe0;
        --ink: #0e0d0b;
        --accent: #ff3b30;
        --card: rgba(255, 255, 255, 0.72);
        --line: rgba(14, 13, 11, 0.14);
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        min-height: 100%;
      }

      body {
        background: #fff7eb;
        color: var(--ink);
        font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif;
      }

      code {
        padding: 0.1rem 0.35rem;
        border-radius: 0.35rem;
        background: rgba(14, 13, 11, 0.08);
        font-family: "SFMono-Regular", "SF Mono", Consolas, monospace;
        font-size: 0.92em;
      }

      main {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem;
      }

      .frame {
        width: min(68rem, 100%);
        border: 2px solid var(--ink);
        border-radius: 2rem;
        background: var(--card);
        box-shadow: 0 1.5rem 4rem rgba(14, 13, 11, 0.14);
        overflow: hidden;
        backdrop-filter: blur(12px);
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(18rem, 20rem);
        gap: 2rem;
        align-items: center;
        padding: 2.25rem;
      }

      .logo {
        width: clamp(5.5rem, 20vw, 8rem);
        display: block;
      }

      h1 {
        margin: 1.25rem 0 0.5rem;
        font-size: clamp(2.5rem, 6vw, 4.6rem);
        line-height: 0.95;
        letter-spacing: -0.08em;
      }

      p {
        margin: 0;
        max-width: 34rem;
        font-size: 1.05rem;
        line-height: 1.55;
      }

      .hero-copy {
        min-width: 0;
      }

      .actions {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: 1rem;
        margin-top: 1.5rem;
      }

      .preview {
        min-width: 0;
      }

      .preview-frame {
        padding: 1rem;
        border: 1px solid var(--line);
        border-radius: 1.5rem;
        background: rgba(255, 255, 255, 0.9);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
      }

      .preview img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 1rem;
        border: 1px solid rgba(14, 13, 11, 0.12);
      }

      .card {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        min-height: 5.5rem;
        padding: 1rem 1.15rem;
        border-radius: 1.2rem;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.88);
        color: inherit;
        text-decoration: none;
        transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
      }

      .card:hover {
        transform: translateY(-2px);
        border-color: rgba(14, 13, 11, 0.32);
        box-shadow: 0 0.8rem 1.6rem rgba(14, 13, 11, 0.08);
      }

      .card strong {
        display: block;
        margin-bottom: 0.2rem;
        font-size: 1rem;
      }

      .card span {
        font-size: 0.92rem;
        color: rgba(14, 13, 11, 0.72);
      }

      .arrow {
        flex: none;
        width: 2.4rem;
        height: 2.4rem;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: var(--ink);
        color: #fff;
        font-size: 1.1rem;
      }

      .release {
        padding: 0 2.25rem 1.8rem;
      }

      .release-card {
        padding: 1.35rem;
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.56);
      }

      .release-kicker {
        display: inline-block;
        margin-bottom: 0.75rem;
        padding: 0.28rem 0.55rem;
        border-radius: 999px;
        background: rgba(255, 59, 48, 0.12);
        color: #9f261d;
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .release-header {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: baseline;
        margin-bottom: 0.45rem;
      }

      .release-header strong {
        font-size: clamp(1.35rem, 4vw, 1.8rem);
        letter-spacing: -0.04em;
      }

      .release-link {
        color: inherit;
        font-size: 0.95rem;
        text-decoration-thickness: 1px;
        text-underline-offset: 0.14em;
      }

      .release-meta {
        color: rgba(14, 13, 11, 0.68);
        font-size: 0.95rem;
      }

      .release-notes {
        margin-top: 1rem;
        color: rgba(14, 13, 11, 0.9);
      }

      .release-notes h3,
      .release-notes h4 {
        margin: 1rem 0 0.35rem;
        letter-spacing: -0.03em;
      }

      .release-notes h3 {
        font-size: 1.05rem;
      }

      .release-notes h4 {
        font-size: 0.95rem;
      }

      .release-notes p {
        max-width: none;
        font-size: 0.98rem;
      }

      .release-notes ul {
        margin: 0.35rem 0 0;
        padding-left: 1.2rem;
      }

      .release-notes li {
        margin: 0.25rem 0;
        font-size: 0.98rem;
        line-height: 1.5;
      }

      .release-notes a {
        color: inherit;
      }

      .release-fallback {
        margin-top: 0.85rem;
        font-size: 0.92rem;
      }

      .release-fallback a {
        color: inherit;
      }

      .footer {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 2.25rem 1.5rem;
        font-size: 0.9rem;
        color: rgba(14, 13, 11, 0.65);
      }

      .footer a {
        color: inherit;
      }

      @media (max-width: 640px) {
        .hero,
        .release,
        .footer {
          padding-left: 1.35rem;
          padding-right: 1.35rem;
        }

        .hero {
          grid-template-columns: 1fr;
          gap: 1.35rem;
        }

        .release {
          padding-bottom: 1.35rem;
        }

        .release-header,
        .footer {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="frame">
        <div class="hero">
          <div class="hero-copy">
            <div class="logo">${logoMarkup}</div>
            <h1>Pocodex</h1>
            <p>
              Use Codex.app in a real browser. Like Claude Code Remote Control, but for Codex.
            </p>
            <div class="actions">
              <a class="card" href="https://download.pocodex.app/" rel="noreferrer">
                <div>
                  <strong>Download Desktop App</strong>
                  <span>Install the latest Pocodex release.</span>
                </div>
                <div class="arrow">↗</div>
              </a>
              <div class="card">
                <div>
                  <strong>Install the CLI</strong>
                  <span><code>npm i -g pocodex</code></span>
                </div>
                <div class="arrow">⌘</div>
              </div>
              <a class="card" href="https://github.com/davej/pocodex" rel="noreferrer">
                <div>
                  <strong>View on GitHub</strong>
                  <span>Read the code, issues, and release notes.</span>
                </div>
                <div class="arrow">↗</div>
              </a>
            </div>
          </div>
          <div class="preview">
            <div class="preview-frame">
              <img
                src="/screenshot.png"
                alt="Pocodex showing the Codex.app interface in the browser"
                width="620"
                height="914"
              >
            </div>
          </div>
        </div>
        <div class="release">
          <section class="release-card" data-release-card>
            <div class="release-kicker">Latest Release</div>
            <div class="release-header">
              <strong data-release-version>Loading latest release...</strong>
              <a
                class="release-link"
                data-release-link
                href="${releasesPageUrl}"
                rel="noreferrer"
                hidden
              >
                View release ↗
              </a>
            </div>
            <p class="release-meta" data-release-meta>
              Checking GitHub for the latest published version and release notes.
            </p>
            <div class="release-notes" data-release-notes hidden></div>
            <div class="release-fallback">
              <a href="${releasesPageUrl}" rel="noreferrer">Browse all releases on GitHub</a>
            </div>
          </section>
        </div>
        <div class="footer">
          <span>Remote Codex access, packaged simply.</span>
          <a href="https://download.pocodex.app/">download.pocodex.app</a>
        </div>
      </section>
    </main>
    <script type="module">
      const releasesPageUrl = ${JSON.stringify(releasesPageUrl)};
      const versionElement = document.querySelector("[data-release-version]");
      const metaElement = document.querySelector("[data-release-meta]");
      const notesElement = document.querySelector("[data-release-notes]");
      const linkElement = document.querySelector("[data-release-link]");

      async function loadLatestRelease() {
        try {
          const response = await fetch("/api/latest-release", {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) {
            throw new Error("release fetch failed");
          }

          const release = await response.json();
          versionElement.textContent = release.version;
          metaElement.textContent = "Published " + release.publishedLabel;
          linkElement.href = release.htmlUrl;
          linkElement.hidden = false;
          notesElement.innerHTML = release.notesHtml;
          notesElement.hidden = false;
        } catch {
          versionElement.textContent = "Latest release";
          metaElement.textContent = "Release details are temporarily unavailable.";
          linkElement.href = releasesPageUrl;
          linkElement.hidden = false;
          notesElement.hidden = true;
        }
      }

      void loadLatestRelease();
    </script>
  </body>
</html>`;
}

export default {
  async fetch(request: Request, _env: unknown, ctx: WorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/favicon.ico") {
      return Response.redirect(new URL("/favicon.png", request.url), 302);
    }

    if (url.pathname === releaseCachePath) {
      return getLatestReleaseResponse(request, ctx);
    }

    return new Response(renderPage(), {
      headers: {
        "cache-control": "public, max-age=300",
        "content-type": "text/html; charset=UTF-8",
      },
    });
  },
};

async function getLatestReleaseResponse(
  request: Request,
  ctx: WorkerExecutionContext,
): Promise<Response> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(new URL(releaseCachePath, request.url).toString(), {
    method: "GET",
  });
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }

  const releaseResponse = await fetch(githubLatestReleaseUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pocodex-site",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });

  if (!releaseResponse.ok) {
    return new Response(
      JSON.stringify({
        error: `GitHub release lookup failed with status ${releaseResponse.status}`,
      }),
      {
        status: 502,
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "application/json; charset=UTF-8",
        },
      },
    );
  }

  const release = (await releaseResponse.json()) as GitHubRelease;
  const payload: LatestReleasePayload = {
    htmlUrl: release.html_url,
    name: release.name ?? normalizeVersionTag(release.tag_name),
    notesHtml: renderReleaseNotes(release.body),
    publishedAt: release.published_at,
    publishedLabel: formatPublishedDate(release.published_at),
    tagName: release.tag_name,
    version: normalizeVersionTag(release.tag_name),
  };

  const response = new Response(JSON.stringify(payload), {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${String(releaseCacheTtlSeconds)}`,
      "content-type": "application/json; charset=UTF-8",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function normalizeVersionTag(tagName: string): string {
  return tagName.replace(/^pocodex-v/, "v");
}

function formatPublishedDate(publishedAt: string | null): string {
  if (!publishedAt) {
    return "recently";
  }

  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(publishedAt));
}

function renderReleaseNotes(markdown: string | null): string {
  const sanitizedMarkdown = stripReleaseNotesBoilerplate(markdown);
  if (!sanitizedMarkdown || sanitizedMarkdown.trim().length === 0) {
    return "<p>No release notes published yet.</p>";
  }

  const htmlParts: string[] = [];
  const paragraphLines: string[] = [];
  let isInsideList = false;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    htmlParts.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "))}</p>`);
    paragraphLines.length = 0;
  };

  const closeList = () => {
    if (!isInsideList) {
      return;
    }
    htmlParts.push("</ul>");
    isInsideList = false;
  };

  for (const rawLine of sanitizedMarkdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      closeList();
      continue;
    }

    if (line.startsWith("### ")) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h4>${renderInlineMarkdown(line.slice(4))}</h4>`);
      continue;
    }

    if (line.startsWith("## ")) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h3>${renderInlineMarkdown(line.slice(3))}</h3>`);
      continue;
    }

    if (line.startsWith("* ") || line.startsWith("- ")) {
      flushParagraph();
      if (!isInsideList) {
        htmlParts.push("<ul>");
        isInsideList = true;
      }
      htmlParts.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    closeList();
    paragraphLines.push(line);
  }

  flushParagraph();
  closeList();

  return htmlParts.join("");
}

function stripReleaseNotesBoilerplate(markdown: string | null): string | null {
  if (!markdown) {
    return markdown;
  }

  return markdown.replace(`\n${releaseNotesBoilerplate}`, "").trimEnd();
}

function renderInlineMarkdown(text: string): string {
  const links: string[] = [];
  const linkPlaceholderPrefix = "__POCODEX_LINK_";

  const textWithPlaceholders = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const placeholder = `${linkPlaceholderPrefix}${String(links.length)}__`;
      links.push(`<a href="${escapeHtmlAttribute(url)}" rel="noreferrer">${escapeHtml(label)}</a>`);
      return placeholder;
    },
  );

  let html = escapeHtml(textWithPlaceholders);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  links.forEach((link, index) => {
    html = html.replace(`${linkPlaceholderPrefix}${String(index)}__`, link);
  });

  return html;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
