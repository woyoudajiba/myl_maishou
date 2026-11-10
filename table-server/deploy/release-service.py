"""Scoped online-table release. Back up live WAL data, probe a clone, then activate.

Run as the existing deploy user. No production table rows are changed by this script.
The model/ERP service and its environment files are outside this release's scope.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

stage = Path(sys.argv[1])
mode = sys.argv[2]
if stage.parent != Path('/home/deploy') or stage.resolve() != stage or not re.fullmatch(r'productC-table-upload-[a-f0-9-]{36}', stage.name):
    raise SystemExit('Invalid staging directory')
if mode not in ('prepare', 'activate', 'site'):
    raise SystemExit('Invalid release phase')
root = Path('/home/wsf/productC')
service_file = root / 'online-table/server.mjs'
database = root / 'online-table/data/online-tables.sqlite'
site_file = root / 'site/maishou/index.html'
feed_file = root / 'updates/latest.yml'
unit = 'maishou-online-table.service'
manifest = json.loads((stage / 'service-manifest.json').read_text())
version = manifest['version']
if not re.fullmatch(r'\d+\.\d+\.\d+-v\d+', version):
    raise SystemExit('Invalid version')
digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
for name in ('server.mjs', 'index.html', 'probe-release.mjs'):
    file = stage / name
    if file.is_symlink() or digest(file) != manifest['files'][name]:
        raise SystemExit('Staged file mismatch: ' + name)
for file in (service_file, database, site_file, feed_file):
    if file.resolve() != file or not file.is_file():
        raise SystemExit('Unsafe or missing production path: ' + str(file))
state_file = stage / 'release-state.json'

def write_json(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    file.chmod(0o600)

def stats():
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as conn:
        return {name: conn.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in ('tables', 'rows', 'table_history')}

def atomic_copy(source, target):
    temp = target.with_name(target.name + '.release-new')
    if temp.exists() or temp.is_symlink():
        raise RuntimeError('Temporary release file already exists')
    with temp.open('xb') as output, source.open('rb') as incoming:
        shutil.copyfileobj(incoming, output)
        output.flush()
        os.fsync(output.fileno())
    temp.chmod(0o644)
    os.replace(temp, target)

def request_status(route):
    try:
        with urllib.request.urlopen('http://127.0.0.1:43900' + route, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

if mode == 'prepare':
    if state_file.exists():
        raise SystemExit('Release already prepared')
    subprocess.run(['node', '--check', str(stage / 'server.mjs')], check=True)
    backup = Path('/home/deploy/productC-release-backups') / (version + '-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    backup.parent.chmod(0o700)
    for source, name in ((service_file, 'server-before.mjs'), (site_file, 'guide-before.html'), (feed_file, 'latest-before.yml')):
        shutil.copy2(source, backup / name)
        (backup / name).chmod(0o600)
    db_backup = backup / 'online-tables.sqlite'
    with sqlite3.connect(database) as live, sqlite3.connect(db_backup) as saved:
        live.backup(saved)
        if saved.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database backup failed integrity check')
    db_backup.chmod(0o600)
    probe = subprocess.run(['node', str(stage / 'probe-release.mjs'), str(db_backup), str(stage / 'migration-clone')], check=True, capture_output=True, text=True)
    result = json.loads(probe.stdout.strip().splitlines()[-1])
    state = {'version': version, 'backup': str(backup), 'databaseBefore': stats(), 'previousServerSha256': digest(service_file), 'probe': result}
    write_json(state_file, state)
    print(json.dumps(state))
else:
    state = json.loads(state_file.read_text())
    backup = Path(state['backup'])
    if backup.resolve() != backup or backup.parent != Path('/home/deploy/productC-release-backups'):
        raise SystemExit('Unsafe backup path')
    if mode == 'activate':
        if digest(service_file) != state['previousServerSha256']:
            raise SystemExit('Production source changed since backup; stop and inspect')
        atomic_copy(stage / 'server.mjs', service_file)
        try:
            subprocess.run(['sudo', '-n', 'systemctl', 'restart', unit], check=True)
            for _ in range(10):
                try:
                    if request_status('/health') == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError('Updated service is not healthy')
            if request_status('/api/tables') != 401:
                raise RuntimeError('Unauthenticated table access was not rejected')
            if stats() != state['databaseBefore']:
                raise RuntimeError('Database row counts changed during release; inspect before continuing')
        except Exception:
            atomic_copy(backup / 'server-before.mjs', service_file)
            subprocess.run(['sudo', '-n', 'systemctl', 'restart', unit], check=True)
            raise
        state.update({'active': True, 'serverSha256': digest(service_file), 'health': 200, 'unauthenticatedTables': 401, 'databaseAfter': stats()})
    else:
        if not state.get('active') or f'releaseName: {version}' not in feed_file.read_text():
            raise SystemExit('Publish matching update artifacts before changing the guide')
        atomic_copy(stage / 'index.html', site_file)
        state.update({'sitePublished': True, 'siteSha256': digest(site_file)})
    write_json(state_file, state)
    print(json.dumps(state))
