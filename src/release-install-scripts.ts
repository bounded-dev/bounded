import type { ReleaseManifest } from "./cli/release-manifest.ts";

const RELEASE_BASE = "https://github.com/bounded-dev/bounded/releases/download";

/** Scripts are generated from the already verified, final manifest. They do not parse untrusted JSON. */
export function installerScripts(manifest: ReleaseManifest, manifestSha256: string): { readonly unix: string; readonly windows: string } {
  const unixTargets = Object.entries(manifest.targets)
    .filter(([id]) => !id.startsWith("windows-"))
    .map(([id, target]) => `  "${id}") archive="${target.archive.name}"; archive_sha="${target.archive.sha256}"; archive_size="${target.archive.size}"; binary_sha="${target.executable.sha256}"; binary_size="${target.executable.size}" ;;`)
    .join("\n");
  const windowsTargets = Object.entries(manifest.targets)
    .filter(([id]) => id.startsWith("windows-"))
    .map(([id, target]) => `  "${id}" { $archive = "${target.archive.name}"; $archiveSha = "${target.archive.sha256}"; $archiveSize = ${target.archive.size}; $binarySha = "${target.executable.sha256}"; $binarySize = ${target.executable.size}; break }`)
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
if [ -e "$bin_dir/bounded" ] && ! grep -q '^# bounded launcher v1$' "$bin_dir/bounded" 2>/dev/null; then
  echo "An unrelated bounded command already exists at $bin_dir/bounded" >&2; exit 1
fi
mkdir -p "$root/releases/v$version" "$bin_dir"
stage=$(mktemp -d "$root/releases/v$version/.stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
download "$release_base$manifest" "$stage/$manifest"
if [ "$(digest "$stage/$manifest")" != "$manifest_sha" ]; then echo "Release manifest SHA-256 mismatch" >&2; exit 1; fi
if [ ! -e "$release" ]; then
  download "$release_base$archive" "$stage/$archive"
  if [ "$(wc -c < "$stage/$archive" | tr -d ' ')" != "$archive_size" ] || [ "$(digest "$stage/$archive")" != "$archive_sha" ]; then
    echo "Release archive size or SHA-256 mismatch" >&2; exit 1
  fi
  case "$archive" in
    *.zip) command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 1; }; unzip -q "$stage/$archive" -d "$stage/unpacked" ;;
    *.tar.gz) mkdir "$stage/unpacked"; tar -xzf "$stage/$archive" -C "$stage/unpacked" ;;
    *) echo "Unsupported release archive" >&2; exit 1 ;;
  esac
  candidate="$stage/unpacked/bounded-v$version"
  if [ ! -f "$candidate/bin/bounded" ] || [ ! -f "$candidate/release.json" ]; then echo "Release archive is incomplete" >&2; exit 1; fi
  if [ "$(wc -c < "$candidate/bin/bounded" | tr -d ' ')" != "$binary_size" ] || [ "$(digest "$candidate/bin/bounded")" != "$binary_sha" ]; then echo "Release executable mismatch" >&2; exit 1; fi
  if [ "$("$candidate/bin/bounded" --version)" != "$version" ]; then echo "Release executable smoke failed" >&2; exit 1; fi
  mv "$candidate" "$release"
fi
if [ ! -f "$release/release.json" ] || [ ! -x "$release/bin/bounded" ] || [ "$(digest "$release/bin/bounded")" != "$binary_sha" ] || [ "$("$release/bin/bounded" --version)" != "$version" ]; then
  echo "Existing release is incomplete or does not match the manifest" >&2; exit 1
fi
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
case "$version" in *..*|.*|*-|*.) echo "Bounded active release is malformed" >&2; exit 1 ;; esac
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
profile="$HOME/.profile"
case "\${SHELL:-}" in */zsh) profile="$HOME/.zprofile" ;; esac
escaped_bin_dir=$(printf '%s' "$bin_dir" | sed 's/[\\$"__BACKTICK__]/\\&/g')
profile_line="export PATH=\"$escaped_bin_dir:\$PATH\" # bounded installer PATH v1"
if [ -f "$profile" ] && grep -Fq '# bounded installer PATH v1' "$profile"; then
  :
else
  printf '\n%s\n' "$profile_line" >> "$profile"
fi
trap - EXIT HUP INT TERM
rm -rf "$stage"
echo "Installed Bounded $version at $bin_dir/bounded"
echo "Open a new shell, or add $bin_dir to PATH for this session."
`
    .replaceAll("__VERSION__", manifest.version)
    .replaceAll("__MANIFEST_SHA__", manifestSha256)
    .replaceAll("__RELEASE_BASE__", RELEASE_BASE)
    .replaceAll("\\${", "${")
    .replace("__UNIX_TARGETS__", unixTargets)
    .replace("__BACKTICK__", "\u0060");
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
$launcher = Join-Path $binDir "bounded.cmd"
if ((Test-Path $launcher) -and -not ((Get-Content $launcher -TotalCount 1) -eq "@REM bounded launcher v1")) { throw "An unrelated bounded command exists at $launcher" }
New-Item -ItemType Directory -Force (Split-Path $release), $binDir | Out-Null
$stage = Join-Path (Split-Path $release) (".stage." + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory $stage | Out-Null
function Download-Https([string]$url, [string]$destination) {
  if (-not $url.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) { throw "HTTPS download required" }
  & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output $destination $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination)) { throw "Download failed: $url" }
}
try {
  $manifestName = "bounded-v$version-manifest-v1.json"
  $manifestPath = Join-Path $stage $manifestName
  Download-Https "$releaseBase$manifestName" $manifestPath
  if ((Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestSha) { throw "Release manifest SHA-256 mismatch" }
  if (-not (Test-Path -LiteralPath $release)) {
    $archivePath = Join-Path $stage $archive
    Download-Https "$releaseBase$archive" $archivePath
    if ((Get-Item $archivePath).Length -ne $archiveSize -or (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveSha) { throw "Release archive size or SHA-256 mismatch" }
    $unpacked = Join-Path $stage "unpacked"
    Expand-Archive -Path $archivePath -DestinationPath $unpacked
    $candidate = Join-Path $unpacked "bounded-v$version"
    $binary = Join-Path $candidate "bin/bounded.exe"
    if (-not (Test-Path $binary) -or -not (Test-Path (Join-Path $candidate "release.json"))) { throw "Release archive is incomplete" }
    if ((Get-Item $binary).Length -ne $binarySize -or (Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binarySha) { throw "Release executable mismatch" }
    if ((& $binary --version) -ne $version -or $LASTEXITCODE -ne 0) { throw "Release executable smoke failed" }
    Move-Item $candidate $release
  }
  $installedBinary = Join-Path $release "bin/bounded.exe"
  if (-not (Test-Path (Join-Path $release "release.json")) -or -not (Test-Path $installedBinary) -or (Get-FileHash $installedBinary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $binarySha -or (& $installedBinary --version) -ne $version -or $LASTEXITCODE -ne 0) { throw "Existing release is incomplete or does not match the manifest" }
  $launcherText = "@REM bounded launcher v1" + [Environment]::NewLine + "@echo off" + [Environment]::NewLine + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bounded-launcher.ps1" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
  $launcherPowerShell = @'
$ErrorActionPreference = "Stop"
$root = Join-Path $env:LOCALAPPDATA "Bounded"
$pointer = Join-Path $root "active"
if (-not (Test-Path -LiteralPath $pointer)) { throw "Bounded active release is missing" }
$activeVersion = [System.IO.File]::ReadAllText($pointer).TrimEnd([char]13, [char]10)
if ($activeVersion -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$') { throw "Bounded active release is malformed" }
$target = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) { "X64" { "windows-x64"; break }; "Arm64" { "windows-arm64"; break }; default { throw "Unsupported Windows CPU" } }
$binary = Join-Path $root ("releases/v" + $activeVersion + "/" + $target + "/bin/bounded.exe")
if (-not (Test-Path -LiteralPath $binary)) { throw "Bounded active executable is missing" }
& $binary @args
exit $LASTEXITCODE
'@
  $temporaryPowerShell = Join-Path $binDir (".bounded-launcher." + [guid]::NewGuid().ToString("N") + ".ps1")
  [System.IO.File]::WriteAllText($temporaryPowerShell, $launcherPowerShell)
  Move-Item -Force $temporaryPowerShell (Join-Path $binDir "bounded-launcher.ps1")
  $temporaryLauncher = Join-Path $binDir (".bounded-launcher." + [guid]::NewGuid().ToString("N") + ".cmd")
  [System.IO.File]::WriteAllText($temporaryLauncher, $launcherText)
  Move-Item -Force $temporaryLauncher $launcher
  $temporaryPointer = Join-Path $root (".active." + [guid]::NewGuid().ToString("N"))
  [System.IO.File]::WriteAllText($temporaryPointer, $version + [Environment]::NewLine)
  Move-Item -Force $temporaryPointer (Join-Path $root "active")
  $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
  $pathEntries = if ([string]::IsNullOrEmpty($userPath)) { @() } else { @($userPath.Split(';')) }
  if (-not ($pathEntries | Where-Object { $_.TrimEnd('\\') -ieq $binDir.TrimEnd('\\') })) {
    $updatedPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { $userPath.TrimEnd(';') + ';' + $binDir }
    [Environment]::SetEnvironmentVariable("Path", $updatedPath, [EnvironmentVariableTarget]::User)
  }
  Write-Output "Installed Bounded $version at $launcher. Open a new terminal to use it."
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

/** One-line commands for an exact release. Both buffer the entire installer before executing it. */
export function releaseBootstrapCommands(pinnedVersion: string): { readonly unix: string; readonly windows: string } {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(pinnedVersion)) {
    throw new Error("A valid exact Bounded release version is required");
  }
  const releaseUrl = `${RELEASE_BASE}/v${pinnedVersion}`;
  return {
    unix: `tmp=$(mktemp) && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$tmp" '${releaseUrl}/install.sh' && test -s "$tmp" && sh "$tmp"; result=$?; rm -f "$tmp"; exit "$result"`,
    windows: `$file = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.ps1'); try { & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output $file '${releaseUrl}/install.ps1'; if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw 'Bounded installer download failed' }; Invoke-Expression ([IO.File]::ReadAllText($file)) } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }`,
  };
}
