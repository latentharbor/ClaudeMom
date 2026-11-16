#!/usr/bin/env python3
"""Prepare an isolated copy; no changes to installed apps, trust or live data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--ca', required=True, type=Path)
    parser.add_argument('--upstreams', required=True, type=Path)
    parser.add_argument('--cli-cache', type=Path)
    parser.add_argument('--web-cache', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path.home() / '.claude-mom-ui-lab'
    app = root / 'Claude UI Lab.app'
    assert not root.exists(), 'An existing lab must be reviewed before replacing it'
    source = args.source.resolve()
    assert source.name == 'Claude.app' and source.is_dir()
    info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
    profile = json.loads(args.reference.read_text())
    assert profile['desktopVersion'] == info['CFBundleShortVersionString']
    raw = (source / 'Contents/Resources/app.asar').read_bytes()
    source_hash = hashlib.sha256(raw).hexdigest()
    root.mkdir(mode=0o700)
    (root / 'tmp').mkdir(mode=0o700)
    subprocess.run(['ditto', str(source), str(app)], check=True)
    _, header_size, _, size = struct.unpack('<4I', raw[:16])
    header = json.loads(raw[16:16 + size])
    body = bytearray(raw[8 + header_size:])

    def get(name):
        item = header['files'][name]
        return body[int(item['offset']):int(item['offset']) + item['size']]

    def put(name, blob):
        block = 4194304
        header['files'][name] = {'size': len(blob), 'offset': str(len(body)), 'integrity': {
            'algorithm': 'SHA256', 'hash': hashlib.sha256(blob).hexdigest(), 'blockSize': block,
            'blocks': [hashlib.sha256(blob[i:i + block]).hexdigest() for i in range(0, len(blob), block)]}}
        body.extend(blob)

    package = json.loads(get('package.json'))
    original_main = package['main']
    package.update(name='claude-ui-lab', productName='Claude UI Lab', main='ui-lab-bootstrap.cjs')
    put('package.json', json.dumps(package, separators=(',', ':')).encode())
    put('ui-lab-original-main.cjs', ('module.exports=require(' + json.dumps('./' + original_main) + ');\n').encode())
    put('ui-lab-bootstrap.cjs', Path(__file__).with_name('ui-lab-bootstrap.cjs').read_bytes())
    encoded = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode()
    payload = struct.pack('<I', len(encoded)) + encoded
    payload += b'\0' * (-len(payload) % 4)
    packed = struct.pack('<I', len(payload)) + payload
    (app / 'Contents/Resources/app.asar').write_bytes(struct.pack('<II', 4, len(packed)) + packed + body)
    for p in app.rglob('Info.plist'):
        try:
            data = plistlib.loads(p.read_bytes())
        except Exception:
            continue
        identifier = data.get('CFBundleIdentifier', '')
        if identifier.startswith('com.anthropic.claudefordesktop'):
            data['CFBundleIdentifier'] = identifier.replace('com.anthropic.claudefordesktop', 'io.latentharbor.claude-ui-lab', 1)
        if p == app / 'Contents/Info.plist':
            data['CFBundleName'] = data['CFBundleDisplayName'] = 'Claude UI Lab'
            data.pop('CFBundleURLTypes', None)
            data.pop('CFBundleDocumentTypes', None)
            data['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = hashlib.sha256(encoded).hexdigest()
        p.write_bytes(plistlib.dumps(data))
    for helper in (app / 'Contents/Frameworks').glob('Claude Helper*.app'):
        p = helper / 'Contents/Info.plist'
        data = plistlib.loads(p.read_bytes())
        old = data['CFBundleExecutable']
        new = old.replace('Claude Helper', 'Claude UI Lab Helper', 1)
        (helper / 'Contents/MacOS' / old).rename(helper / 'Contents/MacOS' / new)
        data['CFBundleExecutable'] = data['CFBundleName'] = data['CFBundleDisplayName'] = new
        p.write_bytes(plistlib.dumps(data))
        helper.rename(helper.with_name(helper.name.replace('Claude Helper', 'Claude UI Lab Helper', 1)))
    integrity = plistlib.loads((app / 'Contents/Info.plist').read_bytes())['ElectronAsarIntegrity']
    digest = hashlib.sha256()
    for name in sorted(integrity):
        for value in [name, integrity[name]['algorithm'], integrity[name]['hash']]:
            digest.update(value.encode())
    framework = app / 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
    binary = bytearray(framework.read_bytes())
    marker = b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A'
    assert binary.count(marker) == 1, 'Unsupported Electron ASAR integrity layout'
    offset = binary.index(marker) + len(marker)
    binary[offset:offset + 34] = b'\x01\x01' + digest.digest()
    framework.write_bytes(binary)
    entitlements = root / 'entitlements.plist'
    entitlements.write_bytes(plistlib.dumps({'com.apple.security.cs.allow-jit': True,
        'com.apple.security.cs.disable-library-validation': True, 'com.apple.security.virtualization': True}))
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', str(entitlements), str(app)], check=True, capture_output=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    runtime = root / 'claude-local'
    runtime.mkdir(mode=0o700)
    if args.web_cache:
        shutil.copytree(args.web_cache, runtime / '.cache')
    shutil.copytree(args.ca, runtime / 'ca')
    shutil.copy2(args.reference, runtime / 'desktop-features.json')
    shutil.copy2(args.upstreams, root / 'upstreams.json')
    settings = {'enabled': True, 'localization': False, 'voiceInput': False, 'computerUse': False,
        'backgroundMode': False, 'cowork': True, 'displayName': 'UI Lab', 'email': 'ui-lab@localhost',
        'plan': 'ultra', 'codeShareHome': False, 'importCliSessions': False, 'sessionSync': False,
        'hideUnroutedModels': True}
    (root / 'settings.json').write_text(json.dumps({'claudeDesktopLocal': settings}))
    home = root / 'profile-home'
    user_data = home / 'Library/Application Support/Claude'
    user_data.mkdir(parents=True)
    (user_data / 'claude_desktop_config.json').write_text(json.dumps({'deploymentMode': '1p', 'mcpServers': {}, 'disableAutoUpdates': True}))
    if args.cli_cache:
        shutil.copytree(args.cli_cache, user_data / 'claude-code')
    scratch = root / 'scratch'
    scratch.mkdir()
    (scratch / 'UI-LAB.txt').write_text('Only the isolated UI lab writes in this folder.\n')
    session_id = '11111111-1111-4111-8111-111111111112'
    record = {'sessionId': 'local_' + session_id, 'cliSessionId': session_id, 'cwd': str(scratch),
        'originCwd': str(scratch), 'createdAt': 1794790000000, 'lastActivityAt': 1794790000000,
        'isArchived': False, 'title': 'UI Lab fixture', 'titleSource': 'manual', 'permissionMode': 'default',
        'sessionPermissionUpdates': [], 'alwaysAllowedReasons': []}
    directory = user_data / 'claude-code-sessions/c46bd1eb-fbbf-4e5a-9bb3-5ebe8521eb54/e0e877d3-8475-44a1-a501-4fc431b085ab'
    directory.mkdir(parents=True)
    (directory / (record['sessionId'] + '.json')).write_text(json.dumps(record))
    project = ''.join(c if c.isalnum() or c == '-' else '-' for c in str(scratch))
    transcripts = home / '.claude-desktop-local/claude-code/projects' / project
    transcripts.mkdir(parents=True)
    parent, reply = str(uuid.uuid4()), str(uuid.uuid4())
    common = {'sessionId': session_id, 'cwd': str(scratch), 'isSidechain': False, 'version': '2.1.325'}
    rows = [{**common, 'type': 'user', 'uuid': parent, 'parentUuid': None, 'timestamp': '2026-11-16T03:00:00Z', 'message': {'role': 'user', 'content': 'UI fixture'}},
        {**common, 'type': 'assistant', 'uuid': reply, 'parentUuid': parent, 'timestamp': '2026-11-16T03:00:01Z', 'message': {'id': 'msg_ui_fixture', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5', 'content': [{'type': 'text', 'text': 'UI fixture ready'}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 3}}}]
    (transcripts / (session_id + '.jsonl')).write_text(''.join(json.dumps(row) + '\n' for row in rows))
    real_home = str(Path.home())
    rules = ['(version 1)', '(allow default)', '(deny file-write* (subpath "/Applications"))',
        '(deny file-write* (require-all (subpath ' + json.dumps(real_home) + ') (require-not (subpath ' + json.dumps(str(root)) + '))))',
        '(deny mach-lookup (global-name "com.apple.securityd"))']
    for p in ['Library/Application Support/Claude', 'Library/Application Support/Claude-3p', 'Library/Application Support/Claude-Shared',
              'Library/Application Support/Claude-Profiles', 'Library/Keychains', 'Library/Logs/Claude', '.claude', '.claude-mom', '.codex', '.config/magpie', '.config/magpie-image']:
        rules.append('(deny file-read* file-write* (subpath ' + json.dumps(str(Path.home() / p)) + '))')
    rules.append('(deny file-read* file-write* (literal ' + json.dumps(str(Path.home() / '.claude.json')) + '))')
    (root / 'isolation.sb').write_text('\n'.join(rules) + '\n')
    for p in root.rglob('*.json'):
        p.chmod(0o600)
    assert hashlib.sha256((source / 'Contents/Resources/app.asar').read_bytes()).hexdigest() == source_hash
    manifest = {'root': str(root), 'app': str(app), 'sourceVersion': info['CFBundleShortVersionString'],
        'sourceAppAsarSHA256': source_hash, 'isolatedProfile': str(user_data), 'fictionalSessions': 1,
        'productionAppUnchanged': True, 'productionSettingsCopied': False, 'productionSessionDataCopied': False}
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
