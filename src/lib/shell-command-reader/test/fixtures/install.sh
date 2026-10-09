#!/usr/bin/env bash
# Installs the toolchain and the project's services on a fresh machine.
set -euo pipefail

PREFIX="${PREFIX:-/usr/local}"
STATE_DIR="$HOME/.local/state/install"
LOG="$STATE_DIR/install.log"
mkdir -p "$STATE_DIR"

log() {
  printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing $1"
    return 1
  fi
}

for tool in curl git tar make; do
  need "$tool" || exit 1
done

# --- component 1: postgres ---
log "installing postgres"
COMPONENT_DIR="build/postgres"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "postgres.tar.gz" ]; then
  curl -fsSL -o "postgres.tar.gz" "https://example.com/releases/postgres-1.0.tar.gz"
fi
tar -xzf "postgres.tar.gz"
cd "postgres-1.0"
./configure --prefix="$PREFIX" --with-config=config/postgres.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "postgres: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/postgres.env" <<EOF
NAME=postgres
VERSION=1.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/postgres.env"
for file in config/postgres/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/postgres.plist" ;;
  Linux) sudo systemctl enable --now "postgres.service" ;;
  *) log "unknown system: not starting postgres" ;;
esac
if git -C "vendor/postgres" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/postgres" pull --ff-only
else
  git clone --depth 1 "https://example.com/postgres.git" "vendor/postgres"
fi
while read -r line; do
  echo "$line" >> "logs/postgres.list"
done < "manifests/postgres.txt"
VERSION_FILE="versions/postgres"
echo "1.0" > "$VERSION_FILE"
grep -q "postgres" installed.txt || echo "postgres" >> installed.txt
test -d "data/postgres" || mkdir -p "data/postgres"
ln -sf "$PREFIX/bin/postgres" "bin/postgres"
log "postgres installed: $(cat "$VERSION_FILE")"
(cd "data/postgres" && ls -la > ../postgres.listing)
sort -u "logs/postgres.list" -o "logs/postgres.list"
wc -l "logs/postgres.list"
# --- component 2: redis ---
log "installing redis"
COMPONENT_DIR="build/redis"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "redis.tar.gz" ]; then
  curl -fsSL -o "redis.tar.gz" "https://example.com/releases/redis-2.0.tar.gz"
fi
tar -xzf "redis.tar.gz"
cd "redis-2.0"
./configure --prefix="$PREFIX" --with-config=config/redis.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "redis: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/redis.env" <<EOF
NAME=redis
VERSION=2.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/redis.env"
for file in config/redis/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/redis.plist" ;;
  Linux) sudo systemctl enable --now "redis.service" ;;
  *) log "unknown system: not starting redis" ;;
esac
if git -C "vendor/redis" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/redis" pull --ff-only
else
  git clone --depth 1 "https://example.com/redis.git" "vendor/redis"
fi
while read -r line; do
  echo "$line" >> "logs/redis.list"
done < "manifests/redis.txt"
VERSION_FILE="versions/redis"
echo "2.0" > "$VERSION_FILE"
grep -q "redis" installed.txt || echo "redis" >> installed.txt
test -d "data/redis" || mkdir -p "data/redis"
ln -sf "$PREFIX/bin/redis" "bin/redis"
log "redis installed: $(cat "$VERSION_FILE")"
(cd "data/redis" && ls -la > ../redis.listing)
sort -u "logs/redis.list" -o "logs/redis.list"
wc -l "logs/redis.list"
# --- component 3: nginx ---
log "installing nginx"
COMPONENT_DIR="build/nginx"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "nginx.tar.gz" ]; then
  curl -fsSL -o "nginx.tar.gz" "https://example.com/releases/nginx-3.0.tar.gz"
fi
tar -xzf "nginx.tar.gz"
cd "nginx-3.0"
./configure --prefix="$PREFIX" --with-config=config/nginx.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "nginx: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/nginx.env" <<EOF
NAME=nginx
VERSION=3.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/nginx.env"
for file in config/nginx/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/nginx.plist" ;;
  Linux) sudo systemctl enable --now "nginx.service" ;;
  *) log "unknown system: not starting nginx" ;;
esac
if git -C "vendor/nginx" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/nginx" pull --ff-only
else
  git clone --depth 1 "https://example.com/nginx.git" "vendor/nginx"
fi
while read -r line; do
  echo "$line" >> "logs/nginx.list"
done < "manifests/nginx.txt"
VERSION_FILE="versions/nginx"
echo "3.0" > "$VERSION_FILE"
grep -q "nginx" installed.txt || echo "nginx" >> installed.txt
test -d "data/nginx" || mkdir -p "data/nginx"
ln -sf "$PREFIX/bin/nginx" "bin/nginx"
log "nginx installed: $(cat "$VERSION_FILE")"
(cd "data/nginx" && ls -la > ../nginx.listing)
sort -u "logs/nginx.list" -o "logs/nginx.list"
wc -l "logs/nginx.list"
# --- component 4: minio ---
log "installing minio"
COMPONENT_DIR="build/minio"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "minio.tar.gz" ]; then
  curl -fsSL -o "minio.tar.gz" "https://example.com/releases/minio-4.0.tar.gz"
fi
tar -xzf "minio.tar.gz"
cd "minio-4.0"
./configure --prefix="$PREFIX" --with-config=config/minio.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "minio: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/minio.env" <<EOF
NAME=minio
VERSION=4.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/minio.env"
for file in config/minio/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/minio.plist" ;;
  Linux) sudo systemctl enable --now "minio.service" ;;
  *) log "unknown system: not starting minio" ;;
esac
if git -C "vendor/minio" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/minio" pull --ff-only
else
  git clone --depth 1 "https://example.com/minio.git" "vendor/minio"
fi
while read -r line; do
  echo "$line" >> "logs/minio.list"
done < "manifests/minio.txt"
VERSION_FILE="versions/minio"
echo "4.0" > "$VERSION_FILE"
grep -q "minio" installed.txt || echo "minio" >> installed.txt
test -d "data/minio" || mkdir -p "data/minio"
ln -sf "$PREFIX/bin/minio" "bin/minio"
log "minio installed: $(cat "$VERSION_FILE")"
(cd "data/minio" && ls -la > ../minio.listing)
sort -u "logs/minio.list" -o "logs/minio.list"
wc -l "logs/minio.list"
# --- component 5: grafana ---
log "installing grafana"
COMPONENT_DIR="build/grafana"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "grafana.tar.gz" ]; then
  curl -fsSL -o "grafana.tar.gz" "https://example.com/releases/grafana-5.0.tar.gz"
fi
tar -xzf "grafana.tar.gz"
cd "grafana-5.0"
./configure --prefix="$PREFIX" --with-config=config/grafana.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "grafana: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/grafana.env" <<EOF
NAME=grafana
VERSION=5.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/grafana.env"
for file in config/grafana/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/grafana.plist" ;;
  Linux) sudo systemctl enable --now "grafana.service" ;;
  *) log "unknown system: not starting grafana" ;;
esac
if git -C "vendor/grafana" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/grafana" pull --ff-only
else
  git clone --depth 1 "https://example.com/grafana.git" "vendor/grafana"
fi
while read -r line; do
  echo "$line" >> "logs/grafana.list"
done < "manifests/grafana.txt"
VERSION_FILE="versions/grafana"
echo "5.0" > "$VERSION_FILE"
grep -q "grafana" installed.txt || echo "grafana" >> installed.txt
test -d "data/grafana" || mkdir -p "data/grafana"
ln -sf "$PREFIX/bin/grafana" "bin/grafana"
log "grafana installed: $(cat "$VERSION_FILE")"
(cd "data/grafana" && ls -la > ../grafana.listing)
sort -u "logs/grafana.list" -o "logs/grafana.list"
wc -l "logs/grafana.list"
# --- component 6: loki ---
log "installing loki"
COMPONENT_DIR="build/loki"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "loki.tar.gz" ]; then
  curl -fsSL -o "loki.tar.gz" "https://example.com/releases/loki-6.0.tar.gz"
fi
tar -xzf "loki.tar.gz"
cd "loki-6.0"
./configure --prefix="$PREFIX" --with-config=config/loki.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "loki: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/loki.env" <<EOF
NAME=loki
VERSION=6.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/loki.env"
for file in config/loki/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/loki.plist" ;;
  Linux) sudo systemctl enable --now "loki.service" ;;
  *) log "unknown system: not starting loki" ;;
esac
if git -C "vendor/loki" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/loki" pull --ff-only
else
  git clone --depth 1 "https://example.com/loki.git" "vendor/loki"
fi
while read -r line; do
  echo "$line" >> "logs/loki.list"
done < "manifests/loki.txt"
VERSION_FILE="versions/loki"
echo "6.0" > "$VERSION_FILE"
grep -q "loki" installed.txt || echo "loki" >> installed.txt
test -d "data/loki" || mkdir -p "data/loki"
ln -sf "$PREFIX/bin/loki" "bin/loki"
log "loki installed: $(cat "$VERSION_FILE")"
(cd "data/loki" && ls -la > ../loki.listing)
sort -u "logs/loki.list" -o "logs/loki.list"
wc -l "logs/loki.list"
# --- component 7: vault ---
log "installing vault"
COMPONENT_DIR="build/vault"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "vault.tar.gz" ]; then
  curl -fsSL -o "vault.tar.gz" "https://example.com/releases/vault-7.0.tar.gz"
fi
tar -xzf "vault.tar.gz"
cd "vault-7.0"
./configure --prefix="$PREFIX" --with-config=config/vault.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "vault: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/vault.env" <<EOF
NAME=vault
VERSION=7.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/vault.env"
for file in config/vault/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/vault.plist" ;;
  Linux) sudo systemctl enable --now "vault.service" ;;
  *) log "unknown system: not starting vault" ;;
esac
if git -C "vendor/vault" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/vault" pull --ff-only
else
  git clone --depth 1 "https://example.com/vault.git" "vendor/vault"
fi
while read -r line; do
  echo "$line" >> "logs/vault.list"
done < "manifests/vault.txt"
VERSION_FILE="versions/vault"
echo "7.0" > "$VERSION_FILE"
grep -q "vault" installed.txt || echo "vault" >> installed.txt
test -d "data/vault" || mkdir -p "data/vault"
ln -sf "$PREFIX/bin/vault" "bin/vault"
log "vault installed: $(cat "$VERSION_FILE")"
(cd "data/vault" && ls -la > ../vault.listing)
sort -u "logs/vault.list" -o "logs/vault.list"
wc -l "logs/vault.list"
# --- component 8: consul ---
log "installing consul"
COMPONENT_DIR="build/consul"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "consul.tar.gz" ]; then
  curl -fsSL -o "consul.tar.gz" "https://example.com/releases/consul-8.0.tar.gz"
fi
tar -xzf "consul.tar.gz"
cd "consul-8.0"
./configure --prefix="$PREFIX" --with-config=config/consul.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "consul: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/consul.env" <<EOF
NAME=consul
VERSION=8.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/consul.env"
for file in config/consul/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/consul.plist" ;;
  Linux) sudo systemctl enable --now "consul.service" ;;
  *) log "unknown system: not starting consul" ;;
esac
if git -C "vendor/consul" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/consul" pull --ff-only
else
  git clone --depth 1 "https://example.com/consul.git" "vendor/consul"
fi
while read -r line; do
  echo "$line" >> "logs/consul.list"
done < "manifests/consul.txt"
VERSION_FILE="versions/consul"
echo "8.0" > "$VERSION_FILE"
grep -q "consul" installed.txt || echo "consul" >> installed.txt
test -d "data/consul" || mkdir -p "data/consul"
ln -sf "$PREFIX/bin/consul" "bin/consul"
log "consul installed: $(cat "$VERSION_FILE")"
(cd "data/consul" && ls -la > ../consul.listing)
sort -u "logs/consul.list" -o "logs/consul.list"
wc -l "logs/consul.list"
# --- component 9: nats ---
log "installing nats"
COMPONENT_DIR="build/nats"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "nats.tar.gz" ]; then
  curl -fsSL -o "nats.tar.gz" "https://example.com/releases/nats-9.0.tar.gz"
fi
tar -xzf "nats.tar.gz"
cd "nats-9.0"
./configure --prefix="$PREFIX" --with-config=config/nats.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "nats: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/nats.env" <<EOF
NAME=nats
VERSION=9.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/nats.env"
for file in config/nats/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/nats.plist" ;;
  Linux) sudo systemctl enable --now "nats.service" ;;
  *) log "unknown system: not starting nats" ;;
esac
if git -C "vendor/nats" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/nats" pull --ff-only
else
  git clone --depth 1 "https://example.com/nats.git" "vendor/nats"
fi
while read -r line; do
  echo "$line" >> "logs/nats.list"
done < "manifests/nats.txt"
VERSION_FILE="versions/nats"
echo "9.0" > "$VERSION_FILE"
grep -q "nats" installed.txt || echo "nats" >> installed.txt
test -d "data/nats" || mkdir -p "data/nats"
ln -sf "$PREFIX/bin/nats" "bin/nats"
log "nats installed: $(cat "$VERSION_FILE")"
(cd "data/nats" && ls -la > ../nats.listing)
sort -u "logs/nats.list" -o "logs/nats.list"
wc -l "logs/nats.list"
# --- component 10: caddy ---
log "installing caddy"
COMPONENT_DIR="build/caddy"
mkdir -p "$COMPONENT_DIR" && cd "$COMPONENT_DIR"
if [ ! -f "caddy.tar.gz" ]; then
  curl -fsSL -o "caddy.tar.gz" "https://example.com/releases/caddy-10.0.tar.gz"
fi
tar -xzf "caddy.tar.gz"
cd "caddy-10.0"
./configure --prefix="$PREFIX" --with-config=config/caddy.conf > configure.log 2>&1
make -j"$(nproc)" >> build.log
make check || log "caddy: checks failed, see build.log"
sudo make install
cd ../..
cat > "config/caddy.env" <<EOF
NAME=caddy
VERSION=10.0
PREFIX=$PREFIX
EOF
chmod 0644 "config/caddy.env"
for file in config/caddy/*.conf; do
  [ -e "$file" ] || continue
  cp "$file" "$STATE_DIR/"
done
case "$(uname -s)" in
  Darwin) launchctl load "launchd/caddy.plist" ;;
  Linux) sudo systemctl enable --now "caddy.service" ;;
  *) log "unknown system: not starting caddy" ;;
esac
if git -C "vendor/caddy" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "vendor/caddy" pull --ff-only
else
  git clone --depth 1 "https://example.com/caddy.git" "vendor/caddy"
fi
while read -r line; do
  echo "$line" >> "logs/caddy.list"
done < "manifests/caddy.txt"
VERSION_FILE="versions/caddy"
echo "10.0" > "$VERSION_FILE"
grep -q "caddy" installed.txt || echo "caddy" >> installed.txt
test -d "data/caddy" || mkdir -p "data/caddy"
ln -sf "$PREFIX/bin/caddy" "bin/caddy"
log "caddy installed: $(cat "$VERSION_FILE")"
(cd "data/caddy" && ls -la > ../caddy.listing)
sort -u "logs/caddy.list" -o "logs/caddy.list"
wc -l "logs/caddy.list"
# Clean up what the builds left.
find build -name '*.o' -print0 | xargs -0 rm -f
rm -rf build/tmp
log "done: $(wc -l < installed.txt) components"
