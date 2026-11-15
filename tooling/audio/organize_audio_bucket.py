#!/usr/bin/env python3
"""Plan/copy a cleaner HF layout. Prune requires verified copies and a live registry.

Steps: --plan, --copy, deploy compatible listener, --publish, --prune.
The saved plan and snapshot remain local; existing audio is never re-encoded.
"""
import argparse
import json
import sys
from pathlib import Path

from archive_storage import copy_plan, plan_layout, prune_plan, verify_plan
from audio_version_worker import Registry, atomic_json, inventory, load_config, public_json, read_tree


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home() / '.config/aura-music/version-worker.json')
    parser.add_argument('--state', type=Path, required=True, help='Local durable plan/snapshot folder')
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--copy', action='store_true')
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--prune', action='store_true')
    args = parser.parse_args()
    if not any((args.plan, args.copy, args.publish, args.prune)):
        parser.error('Choose --plan, --copy, --publish or --prune')
    try:
        config, token = load_config(args.config)
        bucket, state = config['bucket'], args.state.expanduser().resolve()
        registry = Registry(config['site'], token)
        state.mkdir(parents=True, exist_ok=True)
        if args.plan:
            if (state / 'plan.json').exists():
                raise ValueError('Saved plan already exists; use a new state folder')
            tree = read_tree(bucket)
            atomic_json(state / 'tree-before.json', tree)
            current = public_json(registry.url)
            if current.get('source') != 'database':
                raise ValueError('A database-backed registry is required')
            atomic_json(state / 'registry-before.json', current)
            atomic_json(state / 'plan.json', {'bucket': bucket, 'moves': plan_layout(tree)})
        saved = json.loads((state / 'plan.json').read_text())
        if saved['bucket'] != bucket:
            raise ValueError('Plan belongs to another bucket')
        moves = saved['moves']
        print(f'{len(moves)} verified server-side relocations planned', flush=True)
        if args.copy:
            copy_plan(bucket, moves)
            verify_plan(read_tree(bucket), moves)
            atomic_json(state / 'copied.json', {'verified': len(moves)})
            print('Copies verified; source files remain available.', flush=True)
        if args.publish:
            tree = read_tree(bucket)
            verify_plan(tree, moves)
            rows = inventory(tree)
            for offset in range(0, len(rows), 20):
                registry.call('sync', tracks=rows[offset:offset + 20])
            registry.call('reconcile')
            current = public_json(registry.url)
            mapped = {item['source']: item['target'] for item in moves}
            relocating = [{'ref': ref, 'mode': mode, 'path': mapped[file['path']]}
                for ref, versions in current['tracks'].items() for mode, file in versions.items() if file['path'] in mapped]
            for offset in range(0, len(relocating), 40):
                registry.call('relocate', files=relocating[offset:offset + 40])
            current = public_json(registry.url + '?refresh=1')
            atomic_json(state / 'registry-after.json', current)
            atomic_json(state / 'published.json', {'database': True, 'files': len(relocating)})
            print('D1 paths published; local audit snapshot saved.', flush=True)
        if args.prune:
            if not (state / 'published.json').exists():
                raise ValueError('Publish the database paths before pruning')
            tree = read_tree(bucket)
            verify_plan(tree, moves)
            current = public_json(registry.url + '?prune-check=1')
            if current.get('source') != 'database':
                raise ValueError('Live registry is not database-backed')
            deleting = {item['source'] for item in moves}
            if any(file['path'] in deleting for versions in current['tracks'].values() for file in versions.values()):
                raise ValueError('A published rendition still points to an old path')
            originals = [item for item in moves if item['target'].startswith('originals/')]
            # Real byte ranges through both source layouts prove the deployed
            # audio proxy can resolve old cached source keys after the move.
            import urllib.parse
            import urllib.request
            for item in originals[:1]:
                url = config['site'].rstrip('/') + '/api/audio?path=' + urllib.parse.quote(item['target'], safe='')
                with urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-31', 'User-Agent': 'AuraVersionWorker/1.0'}), timeout=60) as response:
                    if response.status != 206 or len(response.read()) != 32:
                        raise ValueError('New audio layout is not playable')
            prune_plan(bucket, tree, moves)
            remaining = {item['path'] for item in read_tree(bucket)}
            if deleting & remaining:
                raise ValueError('Some legacy paths remain; rerun --prune')
            atomic_json(state / 'pruned.json', {'deleted': len(moves)})
            print('Legacy paths removed; verified copies, metadata and local snapshots retained.', flush=True)
        return 0
    except Exception as cause:
        print(f'Organization stopped: {type(cause).__name__}: {cause}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
