"""Back up the existing download feed and guide; publish the matching guide last."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import shutil
import sys

stage=Path(sys.argv[1]);mode=sys.argv[2]
if stage.parent!=Path('/home/deploy') or stage.resolve()!=stage or not re.fullmatch(r'productC-guide-[a-f0-9-]{36}',stage.name):
    raise SystemExit('Invalid private staging directory')
manifest=json.loads((stage/'guide-manifest.json').read_text());version=manifest['version']
if not re.fullmatch(r'\d+\.\d+\.\d+-v\d+',version):raise SystemExit('Invalid version')
root=Path('/home/wsf/productC');guide=root/'site/maishou/index.html';feed=root/'updates/latest.yml';source=stage/'index.html'
sha=lambda file:hashlib.sha256(file.read_bytes()).hexdigest()
if source.is_symlink() or sha(source)!=manifest['sha256']:raise SystemExit('Guide checksum mismatch')
state_file=stage/'state.json'
if mode=='prepare':
    if state_file.exists():raise SystemExit('Backup already prepared')
    backup=Path('/home/deploy/productC-release-backups')/(version+'-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700,parents=True,exist_ok=False)
    for file,name in [(guide,'guide-before.html'),(feed,'latest-before.yml'),(root/'index.html','downloads-before.html')]:
        if file.resolve()!=file:raise SystemExit('Unexpected symlink')
        shutil.copy2(file,backup/name);(backup/name).chmod(0o600)
    result={'version':version,'backup':str(backup),'previousGuideSha256':sha(guide)}
elif mode=='publish':
    result=json.loads(state_file.read_text())
    if 'releaseName: '+version not in feed.read_text():raise SystemExit('Publish matching update feed first')
    if sha(guide)!=result['previousGuideSha256']:raise SystemExit('Guide changed since backup')
    temp=guide.with_name('index.html.publish-new')
    if temp.exists() or temp.is_symlink():raise SystemExit('Temporary file already exists')
    with temp.open('xb') as output:
        output.write(source.read_bytes());output.flush();os.fsync(output.fileno())
    temp.chmod(0o644);os.replace(temp,guide)
    result.update(published=True,sha256=sha(guide))
else:raise SystemExit('Unknown phase')
state_file.write_text(json.dumps(result,indent=2));state_file.chmod(0o600)
print(json.dumps(result))
