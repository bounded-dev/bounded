// The driver's eye (TN-26-006, "Taste stays judged, not gated").
//
//   node render-screenshot.ts [targetDir]
//
// Builds a web target, serves the build output on an ephemeral port,
// screenshots it, and writes `.bounded/render/<timestamp>.png` into the target.
//
// ADVISORY, ALWAYS. It never blocks anything and it exits 0 whatever happens —
// a missing browser, a failing build, a project that is not a frontend at all
// all produce one "unavailable: <why>" line and a zero exit. Visual quality has
// no gate and never will (TN-26-006); what a reviewer and a user lack is not a
// verdict but PIXELS, and this is the cheapest honest way to put some in front
// of them. It is the visual twin of `mutation_score`: measured, reported, never
// a transition.
//
// WHY A STATIC SERVER AND NOT file:// . A built Vite app loads its JS as a
// module from an absolute path, and `file://` refuses module scripts
// cross-origin — the screenshot would be a blank page with a console error
// nobody sees. Forty lines of `node:http` is the whole cost of a real origin,
// and it adds no dependency to the harness or to any target.
//
// WHY THIS IS NOT AN ARCHITECT TOOL. Every gate the architect runs is a named
// tool because the architect has no `bash` — and those tools are wired in the
// harness core, which may not name a technology (TN-26-005). A pack-contributed
// TOOL is the missing socket: the core would own "a pack may expose a driver
// tool", packs would fill it, and `render_screenshot` would arrive in the
// architect's toolset only for projects composing ts-web. That socket does not
// exist yet, so this script is DRIVER-SIDE today: run it from the session that
// has a shell, at wrap, and put the PNG in front of the reviewer. TN-26-006's
// Phase C lists it as the next socket, born with this consumer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { configDriftBlock } from "../../ts/scripts/project-config.ts";

const GUARD = "render-screenshot";

/** Where a rendered screen lands, relative to the target. Under `.bounded/`, which
 *  deliver already teaches every project to gitignore — a PNG per wrap is run
 *  evidence, not a repo artifact. */
export const RENDER_DIR = ".bounded/render";

/** Vite's default build output. Not configurable here on purpose: the vite
 *  config is pack-generated (template.ts) and says `dist`. */
const BUILD_DIR = "dist";

/** Generous: a cold `vite build` on a fresh install, then a browser launch. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;

export interface CommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command in `cwd`. Injectable, so the suite can exercise every branch
 *  without a real Vite build or a real browser. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandOutcome>;

/**
 * ASYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE.
 *
 * The first real run of this script hung for five minutes and died on
 * ETIMEDOUT, having printed "Navigating to http://127.0.0.1:50415/". The
 * browser launched, asked this process for the page — and this process was
 * inside `spawnSync`, which blocks the event loop completely, so the HTTP
 * server it had just started could not answer a single request. The navigation
 * never completed, and the only visible symptom was a timeout that looked like
 * a broken machine.
 *
 * The server and the browser are two halves of one interaction, and the half
 * that lives in this process has to stay awake. Every command here therefore
 * goes through `spawn`, never `spawnSync` — including the build, for uniformity
 * and because "this one is safe to block on" is a comment nobody updates.
 */
export const spawnRun: RunCommand = (command, args, cwd) =>
  new Promise<CommandOutcome>((fulfil) => {
    const child = spawn(command, [...args], { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const settle = (outcome: CommandOutcome): void => {
      clearTimeout(timer);
      fulfil(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ code: null, stdout, stderr: `${stderr}\ntimed out after ${COMMAND_TIMEOUT_MS}ms` });
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e: Error) => settle({ code: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });

export interface RenderResult {
  /** Always 0 outside misuse. This is advisory; it never fails a run. */
  readonly code: 0 | 2;
  readonly lines: readonly string[];
  /** Target-relative path of the PNG, when one was produced. */
  readonly artifact?: string;
}

export interface RenderOptions {
  readonly run?: RunCommand;
  /** The clock, for a deterministic filename in tests. */
  readonly now?: () => Date;
}

/**
 * Where this render lands: `.bounded/render/2026-09-17T16-42-05-123Z.png`.
 *
 * Colons are legal in a POSIX filename and poison on Windows, and a dot before
 * the extension is one dot too many for a reader skimming a directory — so the
 * ISO stamp keeps its shape and loses its punctuation. PURE, so the suite can
 * pin the name without a clock.
 */
export function renderOutputPath(now: Date): string {
  return `${RENDER_DIR}/${now.toISOString().replace(/[:.]/g, "-")}.png`;
}

// --- the static server -------------------------------------------------------

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/**
 * The file a request maps to, or undefined when it escapes the root.
 *
 * PURE, and separate from the server because it is the only part with a way to
 * be wrong: `..` in a URL is the oldest bug in static file serving, and it is
 * worth a test rather than a careful read. A directory (or an unknown path,
 * which a client-side router produces) falls back to `index.html`, the way
 * every static host serves a single-page app.
 */
export function resolveRequestPath(root: string, url: string): string | undefined {
  const requested = decodeURIComponent((url.split("?")[0] ?? "/").split("#")[0] ?? "/");
  const candidate = resolve(root, `.${normalize(requested)}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(root, "index.html");
}

export interface ServedBuild {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Serve `root` on an ephemeral port, bound to loopback only — this exists for
 *  one browser on this machine, and a build served to the network is a build
 *  served to the network. */
export function serveBuild(root: string): Promise<ServedBuild> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const file = resolveRequestPath(root, request.url ?? "/");
    if (file === undefined || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });

  return new Promise<ServedBuild>((fulfil, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? (address as AddressInfo).port : 0;
      fulfil({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

// --- the render --------------------------------------------------------------

function unavailable(why: string, extra: readonly string[] = []): RenderResult {
  return { code: 0, lines: [`${GUARD}: unavailable — ${why}`, ...extra.map((l) => `  ${l}`)] };
}

/** The last few lines of a failed command — enough to see why, without
 *  replaying a whole build into somebody's terminal. */
function tail(out: CommandOutcome, max = 8): string[] {
  return `${out.stdout}\n${out.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-max)
    .map((l) => l.slice(0, 200));
}

/** Did this failure mean "no browser here" rather than "your page is broken"? */
function looksLikeMissingBrowser(out: CommandOutcome): boolean {
  const text = `${out.stdout}${out.stderr}`.toLowerCase();
  return (
    out.code === null ||
    text.includes("executable doesn't exist") ||
    text.includes("please run the following command to download new browsers") ||
    text.includes("playwright install") ||
    text.includes("command not found") ||
    text.includes("could not determine executable to run") ||
    text.includes("404 not found - get https://registry.npmjs.org/playwright")
  );
}

/**
 * Build, serve, shoot.
 *
 * Every failure is advisory and says which of the three it was, because the
 * three have completely different remedies: a build failure is the project's, a
 * missing browser is the machine's, and "not a web target" is nobody's.
 */
export async function renderScreenshot(cwd: string, options: RenderOptions = {}): Promise<RenderResult> {
  const run = options.run ?? spawnRun;
  const now = options.now ?? ((): Date => new Date());

  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return { code: 2, lines: [`${GUARD}: error — '${cwd}' is not a directory`] };
  }
  if (!existsSync(join(cwd, "index.html"))) {
    return unavailable("no index.html in this project — nothing here renders in a browser");
  }
  // The build loads the project's bundler config as code: it must be what the
  // composed packs generate (ADR 2026-054).
  const configBlock = configDriftBlock(GUARD, cwd);
  if (configBlock !== undefined) return { code: 2, lines: configBlock.lines };

  const build = await run("npx", ["vite", "build"], cwd);
  if (build.code !== 0) {
    return unavailable(
      "`npx vite build` failed, so there is nothing to photograph (fix the build; this step " +
        "never blocks a run)",
      tail(build),
    );
  }
  const root = join(cwd, BUILD_DIR);
  if (!existsSync(join(root, "index.html"))) {
    return unavailable(`the build produced no ${BUILD_DIR}/index.html`);
  }

  const outRelative = renderOutputPath(now());
  const outAbsolute = join(cwd, outRelative);
  mkdirSync(join(cwd, RENDER_DIR), { recursive: true });

  const served = await serveBuild(root);
  let shot: CommandOutcome;
  try {
    shot = await run(
      "npx",
      [
        "playwright",
        "screenshot",
        "--browser=chromium",
        "--viewport-size=1280,900",
        "--full-page",
        // The app mounts, fetches nothing (there is no service behind this
        // origin) and paints. A fixed wait beats a load event that fires
        // before React has rendered a single element.
        "--wait-for-timeout=2000",
        served.url,
        outAbsolute,
      ],
      cwd,
    );
  } finally {
    await served.close();
  }

  if (shot.code !== 0 || !existsSync(outAbsolute)) {
    if (looksLikeMissingBrowser(shot)) {
      return unavailable(
        "playwright or its chromium build is not available on this machine — install it " +
          "(`npx playwright install chromium`) if you want pixels at wrap",
        tail(shot),
      );
    }
    return unavailable("the screenshot command failed", tail(shot));
  }

  return {
    code: 0,
    lines: [
      `${GUARD}: wrote ${outRelative} — the screen as a person would see it.`,
      "  Visual quality has no gate and never will (TN-26-006): this is evidence for the",
      "  reviewer and the user to judge, not a verdict. Identity lives in src/ui/theme.css.",
    ],
    artifact: outRelative,
  };
}

// --- CLI ---------------------------------------------------------------------

// Symlink-safe main check (invoked via the ~/.pi/agent symlink): compare realpaths.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = await renderScreenshot(resolve(process.argv[2] ?? process.cwd()));
  for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
  process.exit(result.code);
}
