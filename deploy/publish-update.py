from pathlib import Path
import hashlib
import json
import os
import re
import sys

stage = Path(sys.argv[1])
if stage.parent != Path('/home/deploy') or not re.fullmatch(r'productC-upload-[a-f0-9-]{36}', stage.name) or stage.resolve() != stage:
    raise SystemExit('Invalid upload staging path')
root = Path('/home/wsf/productC')
target = root / 'updates'
if root.resolve() != root or target.resolve() != target or not target.is_dir():
    raise SystemExit('Update directory is missing or resolves outside productC')
manifest = json.loads((stage / 'publish-manifest.json').read_text())
if not re.fullmatch(r'\d+\.\d+\.\d+-v\d+', manifest['version']):
    raise SystemExit('Invalid release version')
digest = lambda file: hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
for file in manifest['files']:
    if not re.fullmatch(r'ProductComparison-[A-Za-z0-9.-]+\.(?:exe|exe.blockmap|zip)', file['name']):
        raise SystemExit('Invalid public filename')
    source = stage / file['name']
    if source.is_symlink() or digest(source) != file['sha256']:
        raise SystemExit('Uploaded artifact checksum mismatch')
    destination = target / file['name']
    if destination.exists() and digest(destination) != file['sha256']:
        raise SystemExit('Release files are immutable; increment the version before publishing')
metadata = stage / 'latest.yml'
if digest(metadata) != manifest['metadataSha256']:
    raise SystemExit('Uploaded metadata checksum mismatch')
for file in manifest['files']:
    destination = target / file['name']
    if not destination.exists():
        os.replace(stage / file['name'], destination)
        destination.chmod(0o644)
installer = next(file['name'] for file in manifest['files'] if file['name'].endswith('.exe'))
extension = next(file['name'] for file in manifest['files'] if file['name'].endswith('.zip'))
page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>找商品工作台下载</title><body style="font-family:system-ui;max-width:700px;margin:64px auto;padding:24px;line-height:1.9"><h1>找商品工作台</h1><p>当前版本：VERSION</p><p><a href="updates/INSTALLER">下载 Windows 安装包</a></p><p><a href="updates/EXTENSION">下载浏览器插件</a></p><p>首次安装后，后续可从软件左侧“软件更新”检查并更新。只有你确认后才会下载和安装。</p><p>客户端已内置插件，可在“使用说明”准备插件并查看完整操作指引；也可下载上方插件ZIP。首次需在 Chrome / Edge 扩展管理页开启开发人员模式并加载插件文件夹。软件升级后，请在使用说明中更新插件文件，再到浏览器重新加载。</p><p>当前安装包未签名。</p></body></html>'''.replace('VERSION', manifest['version']).replace('INSTALLER', installer).replace('EXTENSION', extension)
(root / 'index.html.tmp').write_text(page, encoding='utf-8')
(root / 'index.html.tmp').chmod(0o644)
os.replace(root / 'index.html.tmp', root / 'index.html')
metadata.chmod(0o644)
os.replace(metadata, target / 'latest.yml')
print(json.dumps({'published': manifest['version'], 'filesVerified': len(manifest['files']), 'feed': 'https://wsfile.cn/productC/updates/latest.yml'}))
