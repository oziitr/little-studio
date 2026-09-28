#!/usr/bin/env bash
set -euo pipefail
# Run as root from an uploaded release directory. Leaves Plesk/web/mail/VPN untouched.
[ "$(id -u)" -eq 0 ] || { echo 'Root gerekli'; exit 1; }
APP_ROOT=/opt/little-studio
DATA_ROOT=/var/lib/little-studio
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$SOURCE_DIR" = / ] || [ ! -f "$SOURCE_DIR/server.mjs" ]; then echo 'Geçersiz kaynak dizini'; exit 1; fi
if ss -lnt | awk '{print $4}' | grep -Eq ':3210$' && ! systemctl is-active --quiet little-studio; then echo '3210 portu başka uygulamada kullanılıyor.'; exit 1; fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates curl xz-utils
if ! id little-studio >/dev/null 2>&1; then useradd --system --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin little-studio; fi
install -d -m 755 "$APP_ROOT/releases" "$APP_ROOT/runtime"
install -d -m 700 -o little-studio -g little-studio "$DATA_ROOT"
NODE_VERSION=v24.18.1
ARCH=x64
[ "$(uname -m)" = x86_64 ] || { echo 'Bu paket x86_64 için.'; exit 1; }
if [ ! -x "$APP_ROOT/runtime/node-$NODE_VERSION-linux-$ARCH/bin/node" ]; then
  TEMP_DIR="$(mktemp -d)"
  curl --fail --silent --show-error "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.xz" -o "$TEMP_DIR/node-$NODE_VERSION-linux-$ARCH.tar.xz"
  curl --fail --silent --show-error "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
  (cd "$TEMP_DIR" && grep "  node-$NODE_VERSION-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TEMP_DIR/node-$NODE_VERSION-linux-$ARCH.tar.xz" -C "$APP_ROOT/runtime"
fi
RELEASE="$APP_ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 755 "$RELEASE"
cp "$SOURCE_DIR/server.mjs" "$SOURCE_DIR/core.mjs" "$SOURCE_DIR/package.json" "$RELEASE/"
cp -R "$SOURCE_DIR/lib" "$SOURCE_DIR/public" "$SOURCE_DIR/test" "$RELEASE/"
(cd "$RELEASE" && "$APP_ROOT/runtime/node-$NODE_VERSION-linux-$ARCH/bin/node" --test)
NODE_BIN="$APP_ROOT/runtime/node-$NODE_VERSION-linux-$ARCH/bin"
if grep -q '"playwright"' "$RELEASE/package.json"; then
  export PLAYWRIGHT_BROWSERS_PATH="$APP_ROOT/playwright-browsers"
  (cd "$RELEASE" && PATH="$NODE_BIN:$PATH" npm install --omit=dev --no-audit --no-fund)
  (cd "$RELEASE" && PATH="$NODE_BIN:$PATH" npx playwright install --with-deps chromium)
fi
if [ ! -f /etc/little-studio.env ]; then
  umask 077
  PASSWORD="$(openssl rand -hex 24)"
  printf 'HOST=127.0.0.1\nPORT=3210\nDATA_DIR=/var/lib/little-studio\nSTUDIO_PASSWORD=%s\n' "$PASSWORD" > /etc/little-studio.env
fi
if [ -L "$APP_ROOT/current" ]; then readlink "$APP_ROOT/current" > "$APP_ROOT/previous-release"; fi
ln -sfn "$RELEASE" "$APP_ROOT/current"
cat > /etc/systemd/system/little-studio.service <<EOF
[Unit]
Description=Little Studio video production
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=little-studio
Group=little-studio
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=/etc/little-studio.env
Environment=PLAYWRIGHT_BROWSERS_PATH=$APP_ROOT/playwright-browsers
ExecStart=$APP_ROOT/runtime/node-$NODE_VERSION-linux-$ARCH/bin/node server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=900
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_ROOT
MemoryMax=4G
CPUQuota=200%
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now little-studio
systemctl restart little-studio
for i in $(seq 1 15); do
  if curl --fail --silent http://127.0.0.1:3210/health; then printf '\nLittle Studio hazır. Plesk HTTPS yönlendirmesi ayrıca yapılandırılmalı.\n'; exit 0; fi
  sleep 1
done
echo 'Servis sağlık kontrolü başarısız. journalctl -u little-studio kontrol edilmeli.'
exit 1
