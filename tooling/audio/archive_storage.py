"""Verified, resumable server-side relocation for the Aura HF bucket."""
import json
import os
import re
import urllib.request
from datetime import datetime
from pathlib import Path

AUDIO = re.compile(r'\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$', re.I)
COVER = re.compile(r'\.(jpe?g|png|webp|gif)$', re.I)


def hf_token():
    token = os.environ.get('HF_TOKEN')
    if not token:
        home = Path(os.environ.get('HF_HOME', Path.home() / '.cache/huggingface'))
        token = Path(os.environ.get('HF_TOKEN_PATH', home / 'token')).read_text().strip()
    if not token:
        raise ValueError('Run hf auth login first')
    return token


def batch(bucket, operations):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', bucket):
        raise ValueError('Invalid bucket')
    for offset in range(0, len(operations), 50):
        data = ('\n'.join(json.dumps(item) for item in operations[offset:offset + 50]) + '\n').encode()
        request = urllib.request.Request(f'https://huggingface.co/api/buckets/{bucket}/batch', data,
            headers={'Authorization': 'Bearer ' + hf_token(), 'Content-Type': 'application/x-ndjson', 'User-Agent': 'AuraVersionWorker/1.0'})
        with urllib.request.urlopen(request, timeout=180) as response:
            result = json.load(response)
        if result.get('failed'):
            raise RuntimeError('Some archive operations failed: ' + json.dumps(result['failed'])[:500])


def plan_layout(tree):
    files = {item['path']: item for item in tree if item.get('type') == 'file'}
    moves = {}
    for path in files:
        if '/' not in path and AUDIO.search(path):
            moves[path] = 'originals/' + path
        elif '/' not in path and COVER.search(path):
            moves[path] = 'covers/' + path
        else:
            match = re.fullmatch(r'versions/(bass|bass-reverb)/([A-Za-z0-9_-]{11}|track-[a-f0-9]{20})\.mp3', path)
            if match:
                moves[path] = f'versions/{match[2]}/{match[1]}.mp3'
    plan = []
    for source, target in sorted(moves.items()):
        item = files[source]
        if not item.get('xetHash') or not item.get('mtime') or not isinstance(item.get('size'), int) or item['size'] < 0:
            raise ValueError('Missing copy metadata: ' + source)
        if target in files and (files[target].get('xetHash') != item['xetHash'] or files[target].get('size') != item['size']):
            raise ValueError('Destination collision: ' + target)
        plan.append({'source': source, 'target': target, 'xetHash': item['xetHash'], 'size': item['size'],
                     'mtime': int(datetime.fromisoformat(item['mtime'].replace('Z', '+00:00')).timestamp() * 1000)})
    return plan


def copy_plan(bucket, plan):
    batch(bucket, [{'type': 'copyFile', 'path': item['target'], 'xetHash': item['xetHash'], 'mtime': item['mtime'],
                    'sourceRepoType': 'bucket', 'sourceRepoId': bucket} for item in plan])


def verify_plan(tree, plan):
    files = {item['path']: item for item in tree if item.get('type') == 'file'}
    for item in plan:
        target = files.get(item['target'], {})
        if target.get('xetHash') != item['xetHash'] or target.get('size') != item['size']:
            raise ValueError('Copied file not verified: ' + item['target'])
        source = files.get(item['source'])
        if source and (source.get('xetHash') != item['xetHash'] or source.get('size') != item['size']):
            raise ValueError('Source changed since plan: ' + item['source'])
    return files


def prune_plan(bucket, tree, plan):
    files = verify_plan(tree, plan)
    batch(bucket, [{'type': 'deleteFile', 'path': item['source']} for item in plan if item['source'] in files])
