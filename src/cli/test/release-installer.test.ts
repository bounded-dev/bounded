import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import yazl from "yazl";
import * as releaseInstallScripts from "../../release-install-scripts.ts";
import type { ReleaseManifest } from "../release-manifest.ts";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const version = "9.8.7";
const target = `darwin-${process.arch}`;
const manifestName = `bounded-v${version}-manifest-v1.json`;
const archiveName = `bounded-v${version}-${target}.zip`;
const releaseUrl = `https://github.com/bounded-dev/bounded/releases/download/v${version}`;
const { installerScripts } = releaseInstallScripts;

async function fixture(): Promise<{ root: string; script: string; archive: string; manifest: string; env: Record<string, string | undefined> }> {
  const root = mkdtempSync(join(tmpdir(), "bounded-installer-"));
  const assets = join(root, "assets");
  const fakeBin = join(root, "fake-bin");
  const payload = join(root, "payload", `bounded-v${version}`);
  mkdirSync(join(payload, "bin"), { recursive: true });
  mkdirSync(assets);
  mkdirSync(fakeBin);
  mkdirSync(join(root, "home"));
  const binary = join(payload, "bin", "bounded");
  writeFileSync(binary, `#!/bin/sh\n[ "$1" = "--version" ] && { echo '${version}'; exit 0; }\necho 'bounded fixture'\n`);
  chmodSync(binary, 0o755);
  writeFileSync(join(payload, "release.json"), JSON.stringify({ version }));
  mkdirSync(join(payload, "share", "types"), { recursive: true });
  writeFileSync(join(payload, "share", "types", "index.d.ts"), "export type BoundedFixture = true;\n");
  const archive = join(assets, archiveName);
  const archiveBytes = await new Promise<Buffer>((resolveArchive, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolveArchive(Buffer.concat(chunks)));
    zip.addBuffer(readFileSync(binary), `bounded-v${version}/bin/bounded`, { mode: 0o100755 });
    zip.addBuffer(readFileSync(join(payload, "release.json")), `bounded-v${version}/release.json`);
    zip.addBuffer(readFileSync(join(payload, "share", "types", "index.d.ts")), `bounded-v${version}/share/types/index.d.ts`);
    zip.end();
  });
  writeFileSync(archive, archiveBytes);
  const releaseManifest: ReleaseManifest = {
    schema: "bounded-release/1", version, channel: "stable", sourceCommit: "0123456789abcdef", builtWith: "Bun 1.3.14",
    targets: {
      [target]: {
        minimumOS: "macOS 12",
        archive: { name: archiveName, size: archiveBytes.byteLength, sha256: digest(archiveBytes) },
        executable: { path: "bin/bounded", size: readFileSync(binary).byteLength, sha256: digest(readFileSync(binary)) },
        files: [
          { path: "release.json", size: readFileSync(join(payload, "release.json")).byteLength, sha256: digest(readFileSync(join(payload, "release.json"))) },
          { path: "share/types/index.d.ts", size: readFileSync(join(payload, "share", "types", "index.d.ts")).byteLength, sha256: digest(readFileSync(join(payload, "share", "types", "index.d.ts"))) },
        ],
      },
    },
  };
  const manifest = join(assets, manifestName);
  writeFileSync(manifest, `${JSON.stringify(releaseManifest)}\n`);
  const script = join(root, "install.sh");
  writeFileSync(script, installerScripts(releaseManifest, digest(readFileSync(manifest))).unix);
  const fakeCurl = join(fakeBin, "curl");
  const fakeUname = join(fakeBin, "uname");
  writeFileSync(fakeUname, `#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo ${process.arch === "arm64" ? "arm64" : "x86_64"} ;; esac\n`);
  chmodSync(fakeUname, 0o755);
  writeFileSync(fakeCurl, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CURL_LOG"
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; out="$1" ;;
    https://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  '${releaseUrl}/${manifestName}') cp "$ASSETS/${manifestName}" "$out" ;;
  '${releaseUrl}/${archiveName}') [ "\${FAIL_ARCHIVE:-}" != 1 ] || exit 22; cp "$ASSETS/${archiveName}" "$out" ;;
  *) echo "unexpected URL: $url" >&2; exit 23 ;;
esac
`);
  chmodSync(fakeCurl, 0o755);
  return {
    root, script, archive, manifest,
    env: { ...process.env, HOME: join(root, "home"), PATH: `${fakeBin}:${process.env.PATH ?? ""}`, XDG_DATA_HOME: join(root, "data"), XDG_BIN_HOME: join(root, "bin"), ASSETS: assets, CURL_LOG: join(root, "curl.log") },
  };
}

function run(script: string, env: Record<string, string | undefined>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["sh", script], { env, stdout: "pipe", stderr: "pipe" });
}

test("Unix installer verifies exact pinned assets, installs a working launcher, and persists PATH once", async () => {
  const f = await fixture();
  try {
    const first = run(f.script, f.env);
    expect(first.exitCode).toBe(0);
    const requests = readFileSync(join(f.root, "curl.log"), "utf8").trim().split("\n");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(`${releaseUrl}/${manifestName}`);
    expect(requests[1]).toContain(`${releaseUrl}/${archiveName}`);
    for (const request of requests) {
      expect(request).toContain("--proto =https");
      expect(request).toContain("--proto-redir =https");
    }
    const launcher = join(f.root, "bin", "bounded");
    expect(Bun.spawnSync([launcher, "--version"], { env: f.env, stdout: "pipe" }).stdout.toString().trim()).toBe(version);
    const profiles = [join(f.root, "home", ".profile"), join(f.root, "home", ".zprofile")];
    const profile = profiles.find((path) => existsSync(path));
    expect(profile).toBeDefined();
    if (profile === undefined) throw new Error("installer did not write a persistent shell profile");
    expect(readFileSync(profile, "utf8")).toContain(join(f.root, "bin"));
    expect(run(f.script, f.env).exitCode).toBe(0);
    const lines = readFileSync(profile, "utf8").split("\n").filter((line) => line.includes(join(f.root, "bin")));
    expect(lines).toHaveLength(1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Unix installer leaves the old active release and launcher intact after digest failure or interrupted download", async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.root, "data", "bounded"), { recursive: true });
    mkdirSync(join(f.root, "bin"), { recursive: true });
    writeFileSync(join(f.root, "data", "bounded", "active"), "1.2.3\n");
    const oldLauncher = "#!/bin/sh\n# bounded launcher v1\necho old\n";
    writeFileSync(join(f.root, "bin", "bounded"), oldLauncher);
    const originalArchive = readFileSync(f.archive);
    writeFileSync(f.archive, "corrupt bytes");
    const badDigest = run(f.script, f.env);
    expect(badDigest.exitCode).not.toBe(0);
    expect(badDigest.stderr?.toString()).toMatch(/SHA-256|size/i);
    expect(readFileSync(join(f.root, "data", "bounded", "active"), "utf8")).toBe("1.2.3\n");
    expect(readFileSync(join(f.root, "bin", "bounded"), "utf8")).toBe(oldLauncher);
    writeFileSync(f.archive, originalArchive);
    const interrupted = run(f.script, { ...f.env, FAIL_ARCHIVE: "1" });
    expect(interrupted.exitCode).not.toBe(0);
    expect(readFileSync(join(f.root, "data", "bounded", "active"), "utf8")).toBe("1.2.3\n");
    expect(readFileSync(join(f.root, "bin", "bounded"), "utf8")).toBe(oldLauncher);
    const releases = join(f.root, "data", "bounded", "releases", `v${version}`);
    expect(!existsSync(releases) || readdirSync(releases).length === 0).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Unix installer rejects a changed pinned manifest before downloading an archive", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.manifest, "tampered manifest");
    const result = run(f.script, f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toMatch(/manifest SHA-256 mismatch/i);
    const requests = readFileSync(join(f.root, "curl.log"), "utf8").trim().split("\n");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(`${releaseUrl}/${manifestName}`);
    expect(existsSync(join(f.root, "data", "bounded", "active"))).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Unix launcher rejects an active pointer with shell path metacharacters", async () => {
  const f = await fixture();
  try {
    expect(run(f.script, f.env).exitCode).toBe(0);
    const pointer = join(f.root, "data", "bounded", "active");
    const launcher = join(f.root, "bin", "bounded");
    const marker = join(f.root, "injected");
    writeFileSync(pointer, `9.8.7;touch ${marker}\n`);
    const invoked = Bun.spawnSync([launcher, "--version"], { env: f.env, stdout: "pipe", stderr: "pipe" });
    expect(invoked.exitCode).not.toBe(0);
    expect(invoked.stderr.toString()).toMatch(/malformed/i);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("generated Windows installer refuses HTTPS to HTTP redirects, validates its active pointer, and persists PATH only once", async () => {
  const f = await fixture();
  try {
    const script = installerScripts({
      schema: "bounded-release/1", version, channel: "stable", sourceCommit: "0123456789abcdef", builtWith: "Bun 1.3.14",
      targets: {
        "windows-x64": {
          minimumOS: "Windows 10 1809",
          archive: { name: `bounded-v${version}-windows-x64.zip`, size: 123, sha256: "a".repeat(64) },
          executable: { path: "bin/bounded.exe", size: 456, sha256: "b".repeat(64) }, files: [],
        },
      },
    }, digest(readFileSync(f.manifest))).windows;
    // These are source-level acceptance assertions because native PowerShell and cmd.exe
    // are not available on the macOS development host; Windows CI runs the script itself.
    expect(script).toMatch(/ResponseUri|RequestUri|MaximumRedirection|AllowInsecureRedirect|HttpClientHandler|curl\.exe[\s\S]*--proto-redir/i);
    expect(script).toMatch(/https:/i);
    expect(script).toMatch(/active[\s\S]*\^\[|active[\s\S]*[Vv]ersion[\s\S]*[Mm]atch|active[\s\S]*[Vv]ersion[\s\S]*[Rr]egex/);
    expect(script).toMatch(/User.*Path|EnvironmentVariableTarget.*User|SetEnvironmentVariable/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("published bootstrap commands buffer a pinned HTTPS installer and check transfer success before executing it", () => {
  const exports = releaseInstallScripts as unknown as {
    releaseBootstrapCommands?: (pinnedVersion: string) => { unix: string; windows: string };
  };
  expect(exports.releaseBootstrapCommands).toBeFunction();
  if (exports.releaseBootstrapCommands === undefined) return;
  const { unix, windows } = exports.releaseBootstrapCommands(version);
  for (const command of [unix, windows]) {
    expect(command).toContain(`${releaseUrl}/`);
    expect(command).toContain("install.");
    expect(command).not.toMatch(/releases\/latest|https?:\/\/[^\s]*\/main\//i);
    expect(command).toMatch(/--proto(?:[=\s]+)['"]?=?https/i);
    expect(command).toMatch(/--proto-redir(?:[=\s]+)['"]?=?https/i);
  }
  expect(unix).not.toMatch(/curl[^\n]*\|\s*(?:sh|bash)/);
  expect(unix).toMatch(/(?:-o|--output)\s+[^\s]+/);
  expect(unix).toMatch(/(?:&&|if |\|\|\s*exit)[\s\S]*(?:sh|bash)\s/);
  expect(windows).not.toMatch(/(?:irm|Invoke-RestMethod|Invoke-WebRequest)[\s\S]*\|\s*(?:iex|Invoke-Expression)/i);
  expect(windows).toMatch(/curl\.exe/i);
  expect(windows).toMatch(/LASTEXITCODE/);
  expect(windows).toMatch(/(?:Invoke-Expression|iex)/);
});

test("Unix bootstrap returns to its caller after a successful install", async () => {
  const f = await fixture();
  try {
    const curl = join(f.root, "fake-bin", "curl");
    writeFileSync(curl, `#!/bin/sh
set -eu
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then shift; out="$1"; fi
  shift
done
printf '%s\\n' 'echo installer-ran' > "$out"
`);
    chmodSync(curl, 0o755);
    const unix = releaseInstallScripts.releaseBootstrapCommands(version).unix;
    const result = Bun.spawnSync(["sh", "-c", `${unix}; printf 'caller-survived\\n'`], { env: f.env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("installer-ran");
    expect(result.stdout.toString()).toContain("caller-survived");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Unix installer refuses a control character in the persisted bin path", async () => {
  const f = await fixture();
  try {
    const result = run(f.script, { ...f.env, XDG_BIN_HOME: `${f.root}/bin\nnext-command` });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/bin directory.*control/i);
    expect(existsSync(join(f.root, "data", "bounded", "active"))).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Unix installer verifies every file of an already installed release before activation", async () => {
  const f = await fixture();
  try {
    expect(run(f.script, f.env).exitCode).toBe(0);
    const release = join(f.root, "data", "bounded", "releases", `v${version}`, target);
    const pointer = join(f.root, "data", "bounded", "active");
    writeFileSync(pointer, "1.2.3\n");
    writeFileSync(join(release, "share", "types", "index.d.ts"), "tampered\n");
    const result = run(f.script, f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/release.*mismatch|verification/i);
    expect(readFileSync(pointer, "utf8")).toBe("1.2.3\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Unix installer refuses a modified managed launcher and refreshes its PATH profile when the bin directory moves", async () => {
  const f = await fixture();
  try {
    expect(run(f.script, f.env).exitCode).toBe(0);
    const launcher = join(f.root, "bin", "bounded");
    const originalLauncher = readFileSync(launcher, "utf8");
    writeFileSync(launcher, `${originalLauncher}\necho attacker-owned\n`);
    expect(run(f.script, f.env).exitCode).not.toBe(0);
    writeFileSync(launcher, originalLauncher);
    const movedBin = join(f.root, "other-bin");
    const moved = run(f.script, { ...f.env, XDG_BIN_HOME: movedBin });
    expect(moved.exitCode).toBe(0);
    const profile = [join(f.root, "home", ".profile"), join(f.root, "home", ".zshrc")].find(existsSync);
    expect(profile).toBeDefined();
    if (profile === undefined) throw new Error("profile missing");
    const contents = readFileSync(profile, "utf8");
    expect(contents).toContain(movedBin);
    expect(contents).not.toContain(`${join(f.root, "bin")}:$PATH`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Windows installer checks every release file and owns both launcher files before replacement", async () => {
  const f = await fixture();
  try {
    const raw = JSON.parse(readFileSync(f.manifest, "utf8")) as ReleaseManifest;
    const script = installerScripts({ ...raw, targets: { "windows-x64": {
      minimumOS: "Windows 10 1809", archive: { name: `bounded-v${version}-windows-x64.zip`, size: 1, sha256: "a".repeat(64) },
      executable: { path: "bin/bounded.exe", size: 1, sha256: "b".repeat(64) },
      files: [{ path: "release.json", size: 2, sha256: "c".repeat(64) }],
    } } }, "d".repeat(64)).windows;
    expect(script).toMatch(/bounded-launcher\.ps1[\s\S]*unrelated|unrelated[\s\S]*bounded-launcher\.ps1/i);
    expect(script).toContain("release.json");
    expect(script).toContain("c".repeat(64));
    expect(script).toMatch(/Get-ChildItem[\s\S]*Get-FileHash|Get-FileHash[\s\S]*Get-ChildItem/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
