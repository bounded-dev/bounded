#!/bin/sh
set -eu
job=$1
job=$(cd "$job" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM
mkdir -p "$root/scripts" "$root/clean-bin" "$root/home" "$root/data" "$root/bin"
bun scripts/release/render-native-installer.ts "$job" "$root/scripts"
for utility in sh uname ldd cut wc find mktemp cmp sed grep tar tr cp mv rm chmod cat mkdir sha256sum shasum unzip sandbox-exec; do
  utility_path=$(command -v "$utility" || true)
  if [ -n "$utility_path" ]; then ln -s "$utility_path" "$root/clean-bin/$utility"; fi
done
cat > "$root/clean-bin/curl" <<'CURL'
#!/bin/sh
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; out=$1 ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  https://github.com/bounded-dev/bounded/releases/download/v*/*) ;;
  *) echo 'unexpected release URL' >&2; exit 1 ;;
esac
case "$url" in */*) asset=${url##*/} ;; esac
cp "$BOUNDED_TEST_ASSETS/$asset" "$out"
CURL
chmod 755 "$root/clean-bin/curl"
export BOUNDED_TEST_ASSETS="$job" HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_BIN_HOME="$root/bin" PATH="$root/clean-bin"
if command -v node || command -v bun || command -v npm; then echo 'runtime remains on PATH' >&2; exit 1; fi
sh "$root/scripts/install.sh"
"$root/bin/bounded" --version
printf '{not json' | "$root/bin/bounded" hook claude-code > "$root/hook.json"
grep -q deny "$root/hook.json"
if [ "$(uname -s)" = Darwin ]; then
  # The first quarantined launch ran online in the native workflow. This
  # installed launcher must then work with all network access denied.
  sandbox-exec -p '(version 1) (allow default) (deny network*)' "$root/bin/bounded" --version
  printf '{not json' | sandbox-exec -p '(version 1) (allow default) (deny network*)' "$root/bin/bounded" hook claude-code > "$root/offline-hook.json"
  grep -q deny "$root/offline-hook.json"
fi
receipt=$(find "$root/data/bounded/receipts" -name receipt-v1.json -print -quit)
cp "$receipt" "$root/receipt-before.json"
manifest=$(find "$job" -name '*manifest-v1.json' -print -quit)
cp "$manifest" "$root/manifest-before.json"
printf 'failed install manifest\n' > "$manifest"
if sh "$root/scripts/install.sh"; then echo 'failed install unexpectedly succeeded' >&2; exit 1; fi
"$root/bin/bounded" --version
cmp "$receipt" "$root/receipt-before.json"
cp "$root/manifest-before.json" "$manifest"
