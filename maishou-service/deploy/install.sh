#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/wsf/productC
CONFIG=/etc/nginx/conf.d/auto_liu.conf
BACKUP="$ROOT/wsfile-vhost-before-maishou-$(date +%Y%m%d%H%M%S).bak"

test -s "$ROOT/model-provider.env"
test "$(stat -c '%a' "$ROOT/model-provider.env")" = 600
mkdir -p "$ROOT/backend" "$ROOT/site/maishou/admin" "$ROOT/data"
chmod 700 "$ROOT/data"
chown -R deploy:deploy "$ROOT/backend" "$ROOT/site/maishou" "$ROOT/data"
chmod 600 "$ROOT/model-provider.env"

install -o root -g root -m 644 /tmp/maishou.service /etc/systemd/system/maishou.service
install -o root -g root -m 644 /tmp/maishou-location.conf /etc/nginx/maishou-location.conf
cp -a "$CONFIG" "$BACKUP"
python3 - "$CONFIG" <<'PY'
import pathlib, sys
config = pathlib.Path(sys.argv[1])
text = config.read_text()
marker = '    include /etc/nginx/productC-location.conf;'
addition = '    include /etc/nginx/maishou-location.conf;'
if text.count(addition):
    raise SystemExit(0)
if text.count(marker) != 1:
    raise SystemExit('Expected one ProductComparison location include; Nginx config left unchanged.')
config.write_text(text.replace(marker, marker + '\n' + addition, 1))
PY
systemctl daemon-reload
systemctl enable --now maishou.service
nginx -t
systemctl reload nginx
curl --fail --silent --show-error http://127.0.0.1:4600/healthz >/dev/null
printf 'Maishou service installed; Nginx backup: %s\n' "$BACKUP"
