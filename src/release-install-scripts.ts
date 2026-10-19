import type { ReleaseManifest } from "./cli/release-manifest.ts";

const RELEASE_BASE = "https://github.com/bounded-dev/bounded/releases/download";

function expectedFiles(target: ReleaseManifest["targets"][string]): readonly { readonly path: string; readonly size: number; readonly sha256: string }[] {
  return [target.executable, ...target.files];
}

/** Scripts are generated from the already verified, final manifest. They do not parse untrusted JSON. */
export function installerScripts(manifest: ReleaseManifest, manifestSha256: string): { readonly unix: string; readonly windows: string } {
  const unixTargets = Object.entries(manifest.targets)
    .filter(([id]) => !id.startsWith("windows-"))
    .map(([id, target]) => `  "${id}") archive="${target.archive.name}"; archive_sha="${target.archive.sha256}"; archive_size="${target.archive.size}"; expected_files='${expectedFiles(target).map((file) => `${file.path} ${file.size} ${file.sha256}`).join("\n")}' ;;`)
    .join("\n");
  const windowsTargets = Object.entries(manifest.targets)
    .filter(([id]) => id.startsWith("windows-"))
    .map(([id, target]) => `  "${id}" { $archive = "${target.archive.name}"; $archiveSha = "${target.archive.sha256}"; $archiveSize = ${target.archive.size}; $expectedFiles = @(${expectedFiles(target).map((file) => `@{ Path = "${file.path}"; Size = ${file.size}; Sha256 = "${file.sha256}" }`).join(", ")}); break }`)
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
verify_release() {
  verified_dir=$1
  expected_count=0
  while read -r relative_path expected_size expected_sha; do
    [ -n "$relative_path" ] || continue
    verified_file="$verified_dir/$relative_path"
    if [ ! -f "$verified_file" ] || [ -L "$verified_file" ] || [ "$(wc -c < "$verified_file" | tr -d ' ')" != "$expected_size" ] || [ "$(digest "$verified_file")" != "$expected_sha" ]; then
      return 1
    fi
    expected_count=$((expected_count + 1))
  done <<BOUNDED_EXPECTED_FILES
$expected_files
BOUNDED_EXPECTED_FILES
  [ "$(find "$verified_dir" -type f | wc -l | tr -d ' ')" = "$expected_count" ] && [ -z "$(find "$verified_dir" -type l -print -quit)" ]
}
root="\${XDG_DATA_HOME:-$HOME/.local/share}/bounded"
bin_dir="\${XDG_BIN_HOME:-$HOME/.local/bin}"
case "$bin_dir" in *[![:print:]]*) echo "Bounded bin directory contains control characters" >&2; exit 1 ;; esac
release="$root/releases/v$version/$target"
receipt_dir="$root/receipts/v$version/$target"
manifest_blob_dir="$receipt_dir/manifests"
manifest_blob="$manifest_blob_dir/$manifest_sha.json"
receipt="$receipt_dir/receipt-v1.json"
mkdir -p "$root/releases/v$version" "$bin_dir"
stage=$(mktemp -d "$root/releases/v$version/.stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
launcher="$stage/bounded-launcher"
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
if [ -e "$bin_dir/bounded" ] && ! cmp -s "$bin_dir/bounded" "$launcher"; then
  echo "An unrelated bounded command already exists at $bin_dir/bounded" >&2; exit 1
fi
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
  if ! verify_release "$candidate"; then echo "Release file verification mismatch" >&2; exit 1; fi
  if [ "$("$candidate/bin/bounded" --version)" != "$version" ]; then echo "Release executable smoke failed" >&2; exit 1; fi
  mv "$candidate" "$release"
fi
if ! verify_release "$release" || [ ! -x "$release/bin/bounded" ] || [ "$("$release/bin/bounded" --version)" != "$version" ]; then
  echo "Existing release is incomplete or does not match the manifest" >&2; exit 1
fi
if [ -L "$receipt_dir" ] || [ -L "$manifest_blob_dir" ] || [ -L "$manifest_blob" ] || [ -L "$receipt" ]; then
  echo "Bounded release receipt contains a link" >&2; exit 1
fi
mkdir -p "$manifest_blob_dir"
receipt_expected="$stage/receipt-v1.json"
printf '{"schema":"bounded-install-receipt/1","version":"%s","target":"%s","manifestSha256":"%s"}\n' "$version" "$target" "$manifest_sha" > "$receipt_expected"
if [ -e "$receipt" ] && ! cmp -s "$receipt" "$receipt_expected"; then
  echo "An installed Bounded version has a different manifest receipt" >&2; exit 1
fi
if [ -e "$manifest_blob" ]; then
  if [ ! -f "$manifest_blob" ] || [ "$(digest "$manifest_blob")" != "$manifest_sha" ]; then echo "Installed manifest blob SHA-256 mismatch" >&2; exit 1; fi
else
  cp "$stage/$manifest" "$stage/manifest-blob.json"
  mv "$stage/manifest-blob.json" "$manifest_blob"
fi
if [ ! -e "$receipt" ]; then mv "$receipt_expected" "$receipt"; fi
chmod 755 "$launcher"
mv "$launcher" "$bin_dir/bounded"
profile="$HOME/.profile"
case "\${SHELL:-}" in */zsh) profile="$HOME/.zshrc" ;; esac
escaped_bin_dir=$(printf '%s' "$bin_dir" | sed 's/[\\$"__BACKTICK__]/\\&/g')
profile_line="export PATH=\"$escaped_bin_dir:\$PATH\" # bounded installer PATH v1"
if [ -L "$profile" ]; then echo "Refusing to replace a linked shell profile: $profile" >&2; exit 1; fi
profile_state="$root/profile-line"
if [ -L "$profile_state" ]; then echo "Bounded profile ownership record is linked" >&2; exit 1; fi
marker_lines=''
if [ -f "$profile" ]; then marker_lines=$(grep -F '# bounded installer PATH v1' "$profile" || true); fi
if [ -n "$marker_lines" ]; then
  if [ ! -f "$profile_state" ] || [ "$marker_lines" != "$(cat "$profile_state")" ]; then
    echo "Bounded profile marker is modified or not owned; update PATH manually" >&2; exit 1
  fi
fi
if [ "$marker_lines" = "$profile_line" ]; then
  :
else
  profile_stage=$(mktemp "$HOME/.bounded-profile.XXXXXXXX")
  if [ -f "$profile" ]; then sed '/# bounded installer PATH v1$/d' "$profile" > "$profile_stage"; fi
  printf '\n%s\n' "$profile_line" >> "$profile_stage"
  mv "$profile_stage" "$profile"
fi
printf '%s\n' "$profile_line" > "$root/.profile-line.$$"
mv "$root/.profile-line.$$" "$profile_state"
printf '%s\n' "$version" > "$root/.active.$$"
mv "$root/.active.$$" "$root/active"
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
$receiptDirectory = Join-Path $root "receipts/v$version/$target"
$manifestBlobDirectory = Join-Path $receiptDirectory "manifests"
$manifestBlob = Join-Path $manifestBlobDirectory ($manifestSha + ".json")
$receipt = Join-Path $receiptDirectory "receipt-v1.json"
$launcher = Join-Path $binDir "bounded.cmd"
New-Item -ItemType Directory -Force (Split-Path $release), $binDir | Out-Null
$stage = Join-Path (Split-Path $release) (".stage." + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory $stage | Out-Null
function Download-Https([string]$url, [string]$destination) {
  if (-not $url.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) { throw "HTTPS download required" }
  & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output $destination $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination)) { throw "Download failed: $url" }
}
function Verify-Release([string]$directory) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Release directory is missing" }
  foreach ($expectedFile in $expectedFiles) {
    $file = Join-Path $directory $expectedFile.Path
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Release file verification mismatch: $($expectedFile.Path)" }
    $item = Get-Item -LiteralPath $file -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $expectedFile.Size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedFile.Sha256) { throw "Release file verification mismatch: $($expectedFile.Path)" }
  }
  $entries = @(Get-ChildItem -LiteralPath $directory -Recurse -Force)
  if (@($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0 -or @($entries | Where-Object { -not $_.PSIsContainer }).Count -ne $expectedFiles.Count) { throw "Release contains unexpected files or links" }
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
    Verify-Release $candidate
    if ((& $binary --version) -ne $version -or $LASTEXITCODE -ne 0) { throw "Release executable smoke failed" }
    Move-Item $candidate $release
  }
  $installedBinary = Join-Path $release "bin/bounded.exe"
  Verify-Release $release
  if ((& $installedBinary --version) -ne $version -or $LASTEXITCODE -ne 0) { throw "Existing release is incomplete or does not match the manifest" }
  foreach ($receiptPath in @($receiptDirectory, $manifestBlobDirectory, $manifestBlob, $receipt)) {
    if (Test-Path -LiteralPath $receiptPath) {
      $receiptItem = Get-Item -LiteralPath $receiptPath -Force
      if ($receiptItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Bounded release receipt contains a link" }
    }
  }
  New-Item -ItemType Directory -Force $manifestBlobDirectory | Out-Null
  $receiptExpected = '{"schema":"bounded-install-receipt/1","version":"' + $version + '","target":"' + $target + '","manifestSha256":"' + $manifestSha + '"}' + [Environment]::NewLine
  if ((Test-Path -LiteralPath $receipt) -and [IO.File]::ReadAllText($receipt) -cne $receiptExpected) { throw "An installed Bounded version has a different manifest receipt" }
  if (Test-Path -LiteralPath $manifestBlob) {
    if ((Get-FileHash -LiteralPath $manifestBlob -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestSha) { throw "Installed manifest blob SHA-256 mismatch" }
  } else {
    $stagedBlob = Join-Path $stage "manifest-blob.json"
    [IO.File]::WriteAllBytes($stagedBlob, [IO.File]::ReadAllBytes($manifestPath))
    Move-Item $stagedBlob $manifestBlob
  }
  if (-not (Test-Path -LiteralPath $receipt)) {
    $stagedReceipt = Join-Path $stage "receipt-v1.json"
    [IO.File]::WriteAllText($stagedReceipt, $receiptExpected)
    Move-Item $stagedReceipt $receipt
  }
  $launcherText = "@REM bounded launcher v1" + [Environment]::NewLine + "@echo off" + [Environment]::NewLine + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bounded-launcher.ps1" %*' + [Environment]::NewLine + 'exit /b %ERRORLEVEL%' + [Environment]::NewLine
  $launcherPowerShell = @'
# bounded launcher PowerShell v1
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
  $launcherPowerShellPath = Join-Path $binDir "bounded-launcher.ps1"
  if ((Test-Path -LiteralPath $launcher) -and [IO.File]::ReadAllText($launcher) -cne $launcherText) { throw "An unrelated bounded command exists at $launcher" }
  if ((Test-Path -LiteralPath $launcherPowerShellPath) -and [IO.File]::ReadAllText($launcherPowerShellPath) -cne $launcherPowerShell) { throw "An unrelated bounded launcher script exists at $launcherPowerShellPath" }
  $temporaryPowerShell = Join-Path $binDir (".bounded-launcher." + [guid]::NewGuid().ToString("N") + ".ps1")
  [System.IO.File]::WriteAllText($temporaryPowerShell, $launcherPowerShell)
  Move-Item -Force $temporaryPowerShell $launcherPowerShellPath
  $temporaryLauncher = Join-Path $binDir (".bounded-launcher." + [guid]::NewGuid().ToString("N") + ".cmd")
  [System.IO.File]::WriteAllText($temporaryLauncher, $launcherText)
  Move-Item -Force $temporaryLauncher $launcher
  $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
  $pathEntries = if ([string]::IsNullOrEmpty($userPath)) { @() } else { @($userPath.Split(';')) }
  if (-not ($pathEntries | Where-Object { $_.TrimEnd('\\') -ieq $binDir.TrimEnd('\\') })) {
    $updatedPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { $userPath.TrimEnd(';') + ';' + $binDir }
    [Environment]::SetEnvironmentVariable("Path", $updatedPath, [EnvironmentVariableTarget]::User)
  }
  $temporaryPointer = Join-Path $root (".active." + [guid]::NewGuid().ToString("N"))
  [System.IO.File]::WriteAllText($temporaryPointer, $version + [Environment]::NewLine)
  Move-Item -Force $temporaryPointer (Join-Path $root "active")
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
    unix: `( tmp=$(mktemp) && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$tmp" '${releaseUrl}/install.sh' && test -s "$tmp" && sh "$tmp"; result=$?; rm -f "$tmp"; exit "$result" )`,
    windows: `$file = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.ps1'); try { & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --output $file '${releaseUrl}/install.ps1'; if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw 'Bounded installer download failed' }; Invoke-Expression ([IO.File]::ReadAllText($file)) } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }`,
  };
}
