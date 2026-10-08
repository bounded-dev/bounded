# Shared helpers for `bounded init` and the host adapters' install scripts.
# Source, don't run: `. "$AGENT/scripts/lib/install-helpers.sh"`.

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# Point `link` at `target`, but never clobber a real file or a foreign symlink.
link() {
  local target="$1" link="$2" what="$3"
  mkdir -p "$(dirname "$link")"
  if [ -L "$link" ]; then
    local current; current="$(readlink "$link")"
    if [ "$(readlink -f "$link" 2>/dev/null)" = "$(readlink -f "$target")" ]; then
      ok "$what already linked"; return
    fi
    warn "$what points elsewhere ($current) — leaving it alone"; return
  elif [ -e "$link" ]; then
    warn "$what exists and is a real file — leaving it alone, link it yourself if you meant to"
    return
  fi
  ln -s "$target" "$link"
  ok "$what → $target"
}
