#!/usr/bin/env python3
"""Stage existing processed MP3s; --upload publishes verified files through D1.

This tool never renders audio. Review files locally before explicitly uploading.
Only unfinished database versions are uploaded; published partners stay intact.
"""
import argparse
import contextlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import unicodedata
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from audio_version_worker import (AUDIO, Registry, atomic_json, digest, ensure_file_capacity,
                                 load_config, log, probe_mp3, read_tree, run_command, scan, track_identity)

MODES = {'BASS':'bass','BASS_REVERB':'bass-reverb'}
VIDEO_ID = re.compile(r'\[([A-Za-z0-9_-]{11})\]$')


def filename_key(stem):
    return ' '.join(unicodedata.normalize('NFKC',stem).replace('_',' ').casefold().split())


def prepare(input_dir, output_dir, items, probe=False):
    by_id, by_name = defaultdict(list), defaultdict(list)
    for item in items:
        path = item.get('path','')
        if item.get('type') != 'file' or path.startswith('versions/') or not AUDIO.search(path):
            continue
        match = VIDEO_ID.search(Path(path).stem)
        (by_id[match[1]] if match else by_name[filename_key(Path(path).stem)]).append(item)
    uploads, unmatched, seen = [], [], set()
    for folder, mode in MODES.items():
        directory = input_dir / folder
        if not directory.is_dir():
            raise ValueError(f'Missing processed directory: {directory}')
        for source in sorted(directory.glob('*.mp3')):
            suffix = '_' + folder
            if not source.stem.endswith(suffix):
                unmatched.append({'file':str(source),'reason':'unexpected filename suffix'})
                continue
            stem = source.stem[:-len(suffix)]
            match = VIDEO_ID.search(stem)
            candidates = by_id[match[1]] if match else by_name[filename_key(stem)]
            if not candidates or not match and len(candidates) != 1:
                unmatched.append({'file':str(source),'reason':'missing or ambiguous original'})
                continue
            original = next((item for item in candidates if item['path'].startswith('originals/') and item.get('size',0)>0),candidates[0])
            ref, key, _ = track_identity(original['path'])
            if (ref,mode) in seen:
                raise ValueError(f'Duplicate {mode} rendition for {ref}')
            seen.add((ref,mode))
            entry = {'source':str(source.resolve()),'path':f'versions/{key}/{mode}.mp3',
                     'ref':ref,'storage_key':key,'version':mode,'bytes':source.stat().st_size,
                     'sha256':digest(source),'original_hash':original.get('xetHash')}
            if probe:
                entry['duration'] = float(subprocess.check_output(['ffprobe','-v','error','-show_entries',
                    'format=duration','-of','default=noprint_wrappers=1:nokey=1',str(source)],timeout=60).strip())
                probe_mp3(source,entry['duration'])
            uploads.append(entry)
    if unmatched:
        raise ValueError('Unmatched files; nothing staged:\n' + json.dumps(unmatched,indent=2))
    if not uploads:
        raise ValueError('No processed MP3s found')
    output_dir.mkdir(parents=True,exist_ok=True)
    for entry in uploads:
        target = output_dir / entry['path']
        target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():
            try:
                os.link(entry['source'],target)
            except OSError:
                shutil.copy2(entry['source'],target)
        if digest(target) != entry['sha256']:
            raise ValueError('Existing staging file differs; use a fresh output directory')
    report = {'songs':len({entry['ref'] for entry in uploads}),'files':len(uploads),
              'bytes':sum(entry['bytes'] for entry in uploads),'files_to_upload':uploads}
    atomic_json(output_dir / 'upload-report.json',report)
    return report


def upload_prepared(report, output_dir, registry, config):
    grouped = defaultdict(dict)
    for entry in report['files_to_upload']:
        grouped[entry['ref']][entry['version']] = entry

    def upload(pair):
        ref, entries = pair
        owner, job = str(uuid.uuid4()), None
        finished, lost = threading.Event(), threading.Event()

        def heartbeat():
            while not finished.wait(120):
                try:
                    registry.call('heartbeat',ref=ref,owner=owner)
                except Exception:
                    lost.set()
                    return

        keeper = None
        try:
            # Old servers reject this action before any bytes are uploaded.
            jobs = registry.call('claimOne',ref=ref,owner=owner,limit=1)['tracks']
            if not jobs:
                log(f'Skipped ready, active or unavailable song: {ref}')
                return 'skipped'
            job = jobs[0]
            if job['ref'] != ref or not job['original_hash'] or any(entry['original_hash'] != job['original_hash'] for entry in entries.values()):
                raise ValueError('Original changed; prepare a fresh upload report')
            # Validate the whole claimed batch before uploading its first byte.
            for mode in job['missing']:
                entry = entries.get(mode)
                if not entry or entry['path'] != f'versions/{job["storage_key"]}/{mode}.mp3':
                    raise ValueError('Missing or incorrectly keyed prepared rendition')
                duration = entry.get('duration')
                if not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 0 < duration <= 86400:
                    raise ValueError('Probe audio before publishing')
                source = output_dir / entry['path']
                if source.stat().st_size != entry['bytes'] or digest(source) != entry['sha256']:
                    raise ValueError('Prepared audio changed')
            keeper = threading.Thread(target=heartbeat,daemon=True)
            keeper.start()
            versions = {}
            for mode in job['missing']:
                entry = entries[mode]
                source = output_dir / entry['path']
                if source.stat().st_size != entry['bytes'] or digest(source) != entry['sha256']:
                    raise ValueError('Prepared audio changed')
                if lost.is_set():
                    raise RuntimeError('Lease renewal failed')
                staged = output_dir / 'uploads' / job['storage_key'] / mode
                staged.mkdir(parents=True,exist_ok=True)
                target = staged / f'{mode}.mp3'
                if not target.exists():
                    try:
                        os.link(source,target)
                    except OSError:
                        shutil.copy2(source,target)
                if digest(target) != entry['sha256']:
                    raise ValueError('Upload staging differs from prepared audio')
                run_command(['hf','buckets','sync',str(staged),f'hf://buckets/{config["bucket"]}/versions/{job["storage_key"]}','--no-delete'],
                            output_dir / f'upload-{job["storage_key"]}.log')
                versions[mode] = {'path':entry['path'],'bytes':entry['bytes'],'duration':entry['duration'],
                                  'sha256':entry['sha256'],'recipe':'imported-preprocessed'}
            if lost.is_set():
                raise RuntimeError('Lease renewal failed')
            registry.call('complete',ref=ref,owner=owner,versions=versions)
            log(f'Published imported versions through D1: {ref}')
            return 'ready'
        except Exception as cause:
            log(f'Import failed: {ref}: {type(cause).__name__}: {cause}; local files retained')
            if job:
                with contextlib.suppress(Exception):
                    registry.call('fail',ref=ref,owner=owner,error=str(cause))
            return 'failed'
        finally:
            finished.set()
            if keeper:
                keeper.join(timeout=2)

    with ThreadPoolExecutor(max_workers=config.get('jobs',4)) as pool:
        outcomes = list(pool.map(upload,grouped.items()))
    return {status:outcomes.count(status) for status in ('ready','skipped','failed')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input',type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--config',type=Path,default=Path.home()/'.config/aura-music/version-worker.json')
    parser.add_argument('--bucket',default='Angelrider/sonora')
    parser.add_argument('--tree',type=Path,help='Offline complete archive listing for local preparation')
    parser.add_argument('--probe',action='store_true',help='Verify MP3 codec, bitrate and duration')
    parser.add_argument('--upload',action='store_true',help='Explicitly upload unfinished versions and publish to D1')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',args.bucket):
        parser.error('Expected namespace/bucket')
    source, output = args.input.resolve(),args.output.resolve()
    if source == output or source in output.parents:
        parser.error('Output must be outside the processed source directory')
    try:
        ensure_file_capacity()
        config, registry = None, None
        if args.upload:
            config, token = load_config(args.config)
            if config['bucket'] != args.bucket:
                raise ValueError('Upload bucket differs from worker configuration')
            registry = Registry(config['site'],token)
            scan(config,registry)
        items = json.loads(args.tree.read_text()) if args.tree and not args.upload else read_tree(args.bucket)
        report = prepare(source,output,items,args.probe or args.upload)
        print(f'Prepared {report["songs"]} songs / {report["files"]} MP3s in {output}')
        if args.upload:
            outcome = upload_prepared(report,output,registry,config)
            print(json.dumps(outcome,indent=2))
            return 1 if outcome['failed'] else 0
        print('Review upload-report.json before running again with --upload. No remote files or database records changed.')
        return 0
    except Exception as cause:
        print(f'Preparation stopped: {type(cause).__name__}: {cause}',file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
