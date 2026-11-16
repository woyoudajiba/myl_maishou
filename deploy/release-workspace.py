"""Explicit operator release of the shared table and static workspace pages.

Run as deploy on the server, with a private stage containing a verified manifest.
The model/ERP gateway, credentials, and unrelated Nginx locations are untouched.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error

stage = Path(sys.argv[1])
root = Path('/home/wsf/productC')
unit = 'maishou-online-table.service'
live_code = root / 'online-table/server.mjs'
database = root / 'online-table/data/online-tables.sqlite'
nginx = Path('/etc/nginx/maishou-location.conf')
version = json.loads((stage / 'manifest.json').read_text()).get('version','') if (stage / 'manifest.json').exists() else ''
if not re.fullmatch(r'\d+\.\d+\.\d+-v\d+', version):
    raise SystemExit('Invalid release version')
if stage.parent != Path('/home/deploy') or not stage.name.startswith('productC-workspace-'+version+'-') or stage.resolve() != stage:
    raise SystemExit('Invalid private release stage')
for path in [root, live_code, database, nginx]:
    if path.resolve() != path or path.is_symlink():
        raise SystemExit('Unexpected release target path')

digest = lambda path: hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
manifest = json.loads((stage / 'manifest.json').read_text())
expected = {
    'server.mjs', 'probe-release.mjs', 'migration-probe.mjs', 'maishou-location.conf',
    'site/maishou/table/index.html', 'site/maishou/table/table.js', 'site/maishou/table/table.css',
}
if set(manifest['files']) != expected or manifest['version'] != version:
    raise SystemExit('Unexpected release manifest')
for name, sha in manifest['files'].items():
    source = stage / name
    if source.resolve() != source or digest(source) != sha:
        raise SystemExit('Stage checksum mismatch')
if digest(live_code) != manifest['previousServerSha256'] or digest(nginx) != manifest['previousNginxSha256']:
    raise SystemExit('Production files changed after preflight; recheck before release')
subprocess.run(['/usr/bin/node', '--check', str(stage / 'server.mjs')], check=True)

backup = Path('/home/deploy/productC-release-backups') / stage.name.replace('productC-', '', 1)
backup.mkdir(parents=True, mode=0o700, exist_ok=False)
def copy_db(target):
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as source, sqlite3.connect(target) as dest:
        source.backup(dest)
    target.chmod(0o600)

def db_summary(path):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as connection:
        columns = [row[1] for row in connection.execute('PRAGMA table_info(rows)')]
        original = [name for name in columns if name not in ['confirmed_by', 'confirmed_user_id', 'confirmed_at']]
        values = connection.execute('SELECT ' + ','.join(original) + ' FROM rows ORDER BY id').fetchall()
        return {'tables': connection.execute('SELECT COUNT(*) FROM tables').fetchone()[0],
                'rows': len(values), 'history': connection.execute('SELECT COUNT(*) FROM table_history').fetchone()[0],
                'nonConfirmationRowHash': hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest(),
                'integrity': connection.execute('PRAGMA integrity_check').fetchone()[0]}

copy_db(backup / 'online-tables-before-probe.sqlite')
probe_dir = stage / 'migration-probe'
probe_dir.mkdir(mode=0o700)
shutil.copy2(backup / 'online-tables-before-probe.sqlite', probe_dir / database.name)
before_probe = db_summary(probe_dir / database.name)
probe = subprocess.run(['/usr/bin/node', str(stage / 'migration-probe.mjs'), str(probe_dir)], check=True, capture_output=True, text=True)
after_probe = db_summary(probe_dir / database.name)
if before_probe != after_probe or after_probe['integrity'] != 'ok':
    raise SystemExit('Migration changed existing product rows or task receipts')
functional = subprocess.run(['/usr/bin/node', str(stage / 'probe-release.mjs'), str(backup / 'online-tables-before-probe.sqlite'), str(stage / 'functional-probe')], check=True, capture_output=True, text=True)
probe_result = json.loads(functional.stdout.strip())

old_nginx = nginx.read_text()
new_sections = (stage / 'maishou-location.conf').read_text().split('location = /maishou/table {', 1)[1].split('location = /maishou/admin {', 1)[0]
if old_nginx.count('location = /maishou/admin {') != 1:
    raise SystemExit('Unexpected existing workspace route')
if '/maishou/table' in old_nginx:
    if not all(value in old_nginx for value in ['location = /maishou/table {','location = /maishou/table/ {','location ^~ /maishou/table/ {']):
        raise SystemExit('Incomplete existing workspace route; review before release')
    new_nginx = old_nginx
else:
    new_nginx = old_nginx.replace('location = /maishou/admin {', 'location = /maishou/table {' + new_sections + 'location = /maishou/admin {', 1)
admin = root / 'site/maishou/admin/index.html'
old_admin = admin.read_text()
needle = '<div class="admin-actions"><a id="erp-users-link"'
if '/maishou/table/' in old_admin:
    new_admin = old_admin
else:
    if needle not in old_admin:
        raise SystemExit('Existing account page differs; preserve it and review')
    new_admin = old_admin.replace(needle, '<div class="admin-actions"><a class="quiet" href="/maishou/table/">在线选品表</a><a id="erp-users-link"', 1)

targets = {live_code: stage / 'server.mjs', admin: None}
targets.update({root / name: stage / name for name in expected if name.startswith('site/')})
prior = {}
for target in targets:
    if target.exists():
        saved = backup / target.relative_to(root)
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, saved)
        prior[str(target)] = str(saved)
    else:
        prior[str(target)] = None
shutil.copy2(nginx, backup / 'maishou-location.conf')
for name in ['index.html', 'updates/latest.yml']:
    saved = backup / name
    saved.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / name, saved)

def atomic(target, data, mode=0o644):
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.workspace-release-new')
    with temp.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temp.chmod(mode)
    os.replace(temp, target)

def request_status(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

connections = subprocess.run(['ss', '-Hnt', 'state', 'established', '( sport = :43900 )'], check=True, capture_output=True, text=True).stdout.strip()
if connections:
    raise SystemExit('Shared table has active connections; retry when requests finish')
nginx_candidate = stage / 'nginx-workspace.conf'
nginx_candidate.write_text(new_nginx)
changed_nginx = False
subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit], check=True)
try:
    copy_db(backup / 'online-tables-before-cutover.sqlite')
    before_live = db_summary(database)
    atomic(live_code, (stage / 'server.mjs').read_bytes())
    subprocess.run(['sudo', '-n', 'systemctl', 'start', unit], check=True)
    healthy = False
    for _ in range(20):
        try:
            healthy = request_status('http://127.0.0.1:43900/health') == 200
        except (OSError, urllib.error.URLError):
            pass
        if healthy:
            break
        time.sleep(.3)
    if not healthy or request_status('http://127.0.0.1:43900/api/tables') != 401:
        raise RuntimeError('Shared table health or authentication check failed')
    after_live = db_summary(database)
    if before_live != after_live:
        # No database restoration here: another client may already have written.
        # Retain every live write and use the backup only for operator recovery.
        with sqlite3.connect(database) as check:
            if check.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Live database integrity failed')
    for target, source in targets.items():
        if target == live_code:
            continue
        atomic(target, new_admin.encode() if target == admin else source.read_bytes())
    if new_nginx != old_nginx:
        subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'root', '-m', '644', str(nginx_candidate), str(nginx)], check=True)
        changed_nginx = True
    subprocess.run(['sudo', '-n', 'nginx', '-t'], check=True, capture_output=True)
    if changed_nginx:
        subprocess.run(['sudo', '-n', 'systemctl', 'reload', 'nginx'], check=True)
except Exception:
    subprocess.run(['sudo', '-n', 'systemctl', 'stop', unit], check=False)
    for target, saved in prior.items():
        path = Path(target)
        if saved:
            atomic(path, Path(saved).read_bytes())
        elif path.is_file():
            path.unlink()
    if changed_nginx:
        subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-g', 'root', '-m', '644', str(backup / 'maishou-location.conf'), str(nginx)], check=True)
        subprocess.run(['sudo', '-n', 'nginx', '-t'], check=True, capture_output=True)
        subprocess.run(['sudo', '-n', 'systemctl', 'reload', 'nginx'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'start', unit], check=True)
    raise

with sqlite3.connect(database) as db:
    confirmations = db.execute("SELECT COUNT(*) FROM rows WHERE human_status='approved' AND confirmed_by<>''").fetchone()[0]
summary = {'deployed': True, 'version': manifest['version'], 'backup': str(backup),
           'migrationPreservedOriginalRows': before_probe == after_probe, 'cloneProbe': probe_result,
           'productionBefore': before_live, 'productionAfter': after_live, 'confirmedRowsWithNames': confirmations,
           'tableHealth': 200, 'unauthenticatedTableApi': 401,
           'files': {str(target): digest(target) for target in targets}, 'nginxSha256': digest(nginx),
           'untouchedGatewaySha256': digest(root / 'backend/server.js')}
(stage / 'result.json').write_text(json.dumps(summary, indent=2))
(backup / 'release-result.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
