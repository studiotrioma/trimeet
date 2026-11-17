#!/usr/bin/env python3
# Gera o pacote de atualização do TriMeet (núcleo) dentro do servidor.
# uso: make_update.py <versao> "<novidades>"
import sys, os, json, gzip, base64, hashlib, shutil
ver, notes = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ''
here = os.path.dirname(os.path.abspath(__file__))
core = os.path.join(here, '..', 'app', 'core')
pub = os.path.join(here, '..', 'update')
json.dump({'version': ver}, open(os.path.join(core, 'version.json'), 'w'))
files = {}
for root, _, names in os.walk(core):
    for n in names:
        full = os.path.join(root, n)
        rel = os.path.relpath(full, core).replace(os.sep, '/')
        files[rel] = base64.b64encode(open(full, 'rb').read()).decode()
blob = gzip.compress(json.dumps({'version': ver, 'files': files}).encode(), 9, mtime=0)
os.makedirs(pub, exist_ok=True)
for f in os.listdir(pub): os.remove(os.path.join(pub, f))
name = f'core-{ver}.bin'
open(os.path.join(pub, name), 'wb').write(blob)
json.dump({'version': ver, 'notes': notes, 'bundle': f'/update/{name}', 'sha256': hashlib.sha256(blob).hexdigest()},
          open(os.path.join(pub, 'latest.json'), 'w'), ensure_ascii=False)
print(f'{name}: {len(blob)//1024} KB, {len(files)} arquivos')
