import { logoMarkup } from "./logo";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Pocodex</title>
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

      .footer {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 2.25rem 1.5rem;
        border-top: 1px solid var(--line);
        font-size: 0.9rem;
        color: rgba(14, 13, 11, 0.65);
      }

      .footer a {
        color: inherit;
      }

      @media (max-width: 640px) {
        .hero, .footer {
          padding-left: 1.35rem;
          padding-right: 1.35rem;
        }

        .hero {
          grid-template-columns: 1fr;
          gap: 1.35rem;
        }

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
        <div class="footer">
          <span>Remote Codex access, packaged simply.</span>
          <a href="https://download.pocodex.app/">download.pocodex.app</a>
        </div>
      </section>
    </main>
  </body>
</html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return new Response(page, {
      headers: {
        "cache-control": "public, max-age=300",
        "content-type": "text/html; charset=UTF-8",
      },
    });
  },
};
