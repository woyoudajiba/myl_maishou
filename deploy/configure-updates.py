"""Run once as sudo python3 configure-updates.py after copying this deploy folder.
Only adds an isolated include to the existing wsfile.cn TLS server block.
"""
from pathlib import Path
import datetime
import os
import shutil
import subprocess

root = Path('/home/wsf/productC')
if root.exists() and root.resolve() != root:
    raise SystemExit('Unexpected productC symlink; nothing changed')
root.mkdir(mode=0o755, exist_ok=True)
(root / 'updates').mkdir(mode=0o755, exist_ok=True)
os.chown(root, __import__('pwd').getpwnam('deploy').pw_uid, __import__('grp').getgrnam('deploy').gr_gid)
os.chown(root / 'updates', __import__('pwd').getpwnam('deploy').pw_uid, __import__('grp').getgrnam('deploy').gr_gid)
source = Path(__file__).with_name('productC-location.conf').read_bytes()
include = Path('/etc/nginx/productC-location.conf')
if include.exists() and include.read_bytes() != source:
    raise SystemExit('Existing productC include differs; inspect before replacing')
config = Path('/etc/nginx/conf.d/auto_liu.conf')
before = config.read_bytes()
anchor = b'    include /etc/nginx/netdesk-location.conf;'
entry = b'    include /etc/nginx/productC-location.conf;'
if entry not in before:
    if before.count(anchor) != 1:
        raise SystemExit('Shared TLS include anchor is ambiguous')
    backup = root / ('nginx-before-productC-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S') + '.conf')
    backup.write_bytes(before)
    backup.chmod(0o600)
    include.write_bytes(source)
    config.write_bytes(before.replace(anchor, anchor + b'\n' + entry))
    try:
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except BaseException:
        config.write_bytes(before)
        include.unlink(missing_ok=True)
        subprocess.run(['nginx', '-t'], check=True)
        raise
else:
    if not include.exists():
        raise SystemExit('Include directive exists without file')
    subprocess.run(['nginx', '-t'], check=True)
print('productC update route configured')
