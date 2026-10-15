import type { ReleaseManifest } from "./cli/release-manifest.ts";

const RELEASE_BASE = "https://github.com/bounded-dev/bounded/releases/download";

/** Scripts are generated from the already verified, final manifest. They do not parse untrusted JSON. */
export function installerScripts(manifest: ReleaseManifest, manifestSha256: string): { readonly unix: string; readonly windows: string } {
  const unixTargets = Object.entries(manifest.targets)
    .filter(([id]) => !id.startsWith("windows-"))
    .map(([id, target]) => `  "${id}") archive="${target.archive.name}"; archive_sha="${target.archive.sha256}"; archive_size="${target.archive.size}" ;;`)
    .join("\n");
  const windowsTargets = Object.entries(manifest.targets)
    .filter(([id]) => id.startsWith("windows-"))
    .map(([id, target]) => `  "${id}" { $archive = "${target.archive.name}"; $archiveSha = "${target.archive.sha256}"; $archiveSize = ${target.archive.size}; break }`)
    .join("\n");
  const unix = String.raw`#!/bin/sh
set -eu
version='__VERSION__'
manifest_sha='__MANIFEST_SHA__'
release_base='__RELEASE_BASE__/v__VERSION__/'
manifest="bounded-v$version-manifest-v1.json"
platform=$(uname -s)
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported CPU: $arch" >&2; exit 1 ;; esac
case "$platform" in
  Darwin) target="darwin-$arch" ;;
  Linux)
    if command -v ldd >/dev/null 2>&1; then
      libc_report=$(ldd --version 2>&1 || true)
      case "$libc_report" in *musl*) libc=musl ;; *GLIBC*|*glibc*|*GNU\ libc*) libc=gnu ;; *) echo "Cannot identify Linux libc" >&2; exit 1 ;; esac
    else echo "Cannot identify Linux libc" >&2; exit 1; fi
    target="linux-$arch-$libc" ;;
  *) echo "Unsupported OS: $platform" >&2; exit 1 ;;
esac
case "$target" in
__UNIX_TARGETS__
  *) echo "Release $version does not support $target" >&2; exit 1 ;;
esac
if command -v sha256sum >/dev/null 2>&1; then digest() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else echo "SHA-256 tool required (sha256sum or shasum)" >&2; exit 1; fi
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" --output "$2"
}
root="\${XDG_DATA_HOME:-$HOME/.local/share}/bounded"
bin_dir="\${XDG_BIN_HOME:-$HOME/.local/bin}"
release="$root/releases/v$version/$target"
if [ -e "$release" ]; then echo "Release directory already exists: $release" >&2; exit 1; fi
if [ -e "$bin_dir/bounded" ] && ! grep -q '^# bounded launcher v1$' "$bin_dir/bounded" 2>/dev/null; then
  echo "An unrelated bounded command already exists at $bin_dir/bounded" >&2; exit 1
fi
mkdir -p "$root/releases/v$version" "$bin_dir"
stage=$(mktemp -d "$root/releases/v$version/.stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
download "$release_base$manifest" "$stage/$manifest"
if [ "$(digest "$stage/$manifest")" != "$manifest_sha" ]; then echo "Release manifest SHA-256 mismatch" >&2; exit 1; fi
download "$release_base$archive" "$stage/$archive"
if [ "$(wc -c < "$stage/$archive" | tr -d ' ')" != "$archive_size" ] || [ "$(digest "$stage/$archive")" != "$archive_sha" ]; then
  echo "Release archive size or SHA-256 mismatch" >&2; exit 1
fi
case "$archive" in
  *.zip) command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 1; }; unzip -q "$stage/$archive" -d "$stage/unpacked" ;;
  *.tar.gz) mkdir "$stage/unpacked"; tar -xzf "$stage/$archive" -C "$stage/unpacked" ;;
esac
candidate="$stage/unpacked/bounded-v$version"
if [ ! -f "$candidate/bin/bounded" ] || [ ! -f "$candidate/release.json" ]; then echo "Release archive is incomplete" >&2; exit 1; fi
if [ "$("$candidate/bin/bounded" --version)" != "$version" ]; then echo "Release executable smoke failed" >&2; exit 1; fi
mv "$candidate" "$release"
launcher="$bin_dir/.bounded-launcher.$$"
cat > "$launcher" <<'BOUNDED_LAUNCHER'
#!/bin/sh
# bounded launcher v1
set -eu
root="\${XDG_DATA_HOME:-$HOME/.local/share}/bounded"
pointer="$root/active"
if [ ! -r "$pointer" ]; then echo "Bounded active release is missing" >&2; exit 1; fi
version=$(cat "$pointer")
case "$version" in *[!A-Za-z0-9.+-]*|'') echo "Bounded active release is malformed" >&2; exit 1 ;; esac
platform=$(uname -s); arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported CPU" >&2; exit 1 ;; esac
case "$platform" in Darwin) target="darwin-$arch" ;; Linux) report=$(ldd --version 2>&1 || true); case "$report" in *musl*) libc=musl ;; *GLIBC*|*glibc*|*GNU\ libc*) libc=gnu ;; *) echo "Unknown Linux libc" >&2; exit 1 ;; esac; target="linux-$arch-$libc" ;; *) echo "Unsupported OS" >&2; exit 1 ;; esac
binary="$root/releases/v$version/$target/bin/bounded"
if [ ! -x "$binary" ]; then echo "Bounded active executable is missing" >&2; exit 1; fi
exec "$binary" "$@"
BOUNDED_LAUNCHER
chmod 755 "$launcher"
mv "$launcher" "$bin_dir/bounded"
printf '%s\n' "$version" > "$root/.active.$$"
mv "$root/.active.$$" "$root/active"
trap - EXIT HUP INT TERM
rm -rf "$stage"
echo "Installed Bounded $version at $bin_dir/bounded"
echo "Add $bin_dir to PATH for this and future shell sessions."
`
    .replaceAll("__VERSION__", manifest.version)
    .replaceAll("__MANIFEST_SHA__", manifestSha256)
    .replaceAll("__RELEASE_BASE__", RELEASE_BASE)
    .replaceAll("\\${", "${")
    .replace("__UNIX_TARGETS__", unixTargets);
  const windows = String.raw`$ErrorActionPreference = "Stop"
$version = "__VERSION__"
$manifestSha = "__MANIFEST_SHA__"
$releaseBase = "__RELEASE_BASE__/v__VERSION__/"
$target = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  "X64" { "windows-x64"; break }
  "Arm64" { "windows-arm64"; break }
  default { throw "Unsupported Windows CPU" }
}
switch ($target) {
__WINDOWS_TARGETS__
  default { throw "Release $version does not support $target" }
}
$root = Join-Path $env:LOCALAPPDATA "Bounded"
$binDir = Join-Path $root "bin"
$release = Join-Path $root "releases/v$version/$target"
if (Test-Path $release) { throw "Release directory already exists: $release" }
$launcher = Join-Path $binDir "bounded.cmd"
if ((Test-Path $launcher) -and -not ((Get-Content $launcher -TotalCount 1) -eq "@REM bounded launcher v1")) { throw "An unrelated bounded command exists at $launcher" }
New-Item -ItemType Directory -Force (Split-Path $release), $binDir | Out-Null
$stage = Join-Path (Split-Path $release) (".stage." + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory $stage | Out-Null
try {
  $manifestName = "bounded-v$version-manifest-v1.json"
  $manifestPath = Join-Path $stage $manifestName
  Invoke-WebRequest -Uri "$releaseBase/$manifestName" -OutFile $manifestPath
  if ((Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestSha) { throw "Release manifest SHA-256 mismatch" }
  $archivePath = Join-Path $stage $archive
  Invoke-WebRequest -Uri "$releaseBase/$archive" -OutFile $archivePath
  if ((Get-Item $archivePath).Length -ne $archiveSize -or (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveSha) { throw "Release archive size or SHA-256 mismatch" }
  $unpacked = Join-Path $stage "unpacked"
  Expand-Archive -Path $archivePath -DestinationPath $unpacked
  $candidate = Join-Path $unpacked "bounded-v$version"
  $binary = Join-Path $candidate "bin/bounded.exe"
  if (-not (Test-Path $binary) -or -not (Test-Path (Join-Path $candidate "release.json"))) { throw "Release archive is incomplete" }
  if ((& $binary --version) -ne $version) { throw "Release executable smoke failed" }
  Move-Item $candidate $release
  $launcherText = "@REM bounded launcher v1" + [Environment]::NewLine + "@echo off" + [Environment]::NewLine + "set /p BOUNDED_ACTIVE=<""%LOCALAPPDATA%\Bounded\active""" + [Environment]::NewLine + "if not exist ""%LOCALAPPDATA%\Bounded\releases\v%BOUNDED_ACTIVE%\$target\bin\bounded.exe"" exit /b 1" + [Environment]::NewLine + """%LOCALAPPDATA%\Bounded\releases\v%BOUNDED_ACTIVE%\$target\bin\bounded.exe"" %*" + [Environment]::NewLine
  $temporaryLauncher = Join-Path $binDir (".bounded-launcher." + [guid]::NewGuid().ToString("N") + ".cmd")
  [System.IO.File]::WriteAllText($temporaryLauncher, $launcherText)
  Move-Item -Force $temporaryLauncher $launcher
  $temporaryPointer = Join-Path $root (".active." + [guid]::NewGuid().ToString("N"))
  [System.IO.File]::WriteAllText($temporaryPointer, $version + [Environment]::NewLine)
  Move-Item -Force $temporaryPointer (Join-Path $root "active")
  Write-Output "Installed Bounded $version at $launcher. Add $binDir to PATH."
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
`
    .replaceAll("__VERSION__", manifest.version)
    .replaceAll("__MANIFEST_SHA__", manifestSha256)
    .replaceAll("__RELEASE_BASE__", RELEASE_BASE)
    .replace("__WINDOWS_TARGETS__", windowsTargets);
  return { unix, windows };
}
