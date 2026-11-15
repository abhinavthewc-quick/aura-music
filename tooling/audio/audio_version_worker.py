#!/usr/bin/env python3
"""Resumable Mac worker: discover, download, aubatch, hf sync, then publish to D1.

Credentials live outside the repository. --once drains eligible work; --watch
checks periodically. --dry-run is read-only and does not claim jobs.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import resource
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from archive_storage import copy_plan, plan_layout, prune_plan, verify_plan

MODES = ('bass', 'bass-reverb')
PRESETS = {
    'bx': 'Plugin Alliance/bx_subfilter/MINE.aupreset',
    'lux': 'Luxora Audio International/LUX Sub-Bass/MINE.aupreset',
    'reverb': 'Apple/AUMatrixReverb/MINE.aupreset',
}
AUDIO = re.compile(r'\.(mp3|opus|webm|m4a|flac|wav|aac|ogg)$', re.I)
STOP = threading.Event()


def log(message):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), message, flush=True)


def ensure_file_capacity(minimum=4096):
    """Give this worker and its child tools headroom without changing the shell."""
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    target = minimum if hard == resource.RLIM_INFINITY else min(minimum, hard)
    if soft != resource.RLIM_INFINITY and soft < target:
        resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))


def open_request(request, timeout):
    """Retry failed DNS lookups, which happen before sending the request.

    Other errors may follow a committed mutation, so they are not retried.
    """
    for attempt in range(4):
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.URLError as cause:
            if not isinstance(cause.reason, socket.gaierror) or attempt == 3:
                raise
            delay = 2 ** (attempt + 1)
            log(f'DNS lookup failed; retrying in {delay}s ({attempt + 1}/3)')
            if STOP.wait(delay):
                raise


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    os.replace(temporary, path)


def public_json(url, optional=False):
    try:
        with open_request(urllib.request.Request(url, headers={'User-Agent': 'AuraVersionWorker/1.0'}), timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        error.close()
        if optional and error.code == 404:
            return None
        raise


def read_tree(bucket):
    url = f'https://huggingface.co/api/buckets/{bucket}/tree?recursive=true'
    result, seen = [], set()
    for _ in range(100):
        with open_request(urllib.request.Request(url, headers={'User-Agent': 'AuraVersionWorker/1.0'}), timeout=60) as response:
            items = json.load(response)
            if not isinstance(items, list):
                raise ValueError('Invalid archive tree')
            for item in items:
                if item.get('path') not in seen:
                    result.append(item)
                    seen.add(item.get('path'))
            next_page = re.search(r'<([^>]+)>;\s*rel="next"', response.headers.get('Link', ''))
        if not next_page:
            return result
        url = next_page.group(1)
        if urllib.parse.urlparse(url).netloc != 'huggingface.co':
            raise ValueError('Unexpected pagination host')
    raise ValueError('Incomplete archive tree; refusing to reconcile')


def track_identity(path):
    identity_path = path.removeprefix('originals/')
    match = re.search(r'\[([A-Za-z0-9_-]{11})\]$', Path(identity_path).stem)
    ref = 'video:' + match[1] if match else 'id:hf:' + identity_path
    key = match[1] if match else 'track-' + hashlib.sha256(ref.encode()).hexdigest()[:20]
    return ref, key, 'hf:' + identity_path


def inventory(tree):
    files = {item['path']: item for item in tree if item.get('type') == 'file'}
    result = {}
    for path, item in files.items():
        if path.startswith('versions/') or not AUDIO.search(path) or item.get('size', 0) <= 0:
            continue
        if any(hidden in path.casefold() for hidden in ('michael jackson', 'weeknd', 'jackson 5', 'the jacksons', 'jacksons', '[34na4j8avga]')):
            continue
        ref, key, original_id = track_identity(path)
        if ref in result and not path.startswith('originals/'):
            continue
        versions = {}
        for mode in MODES:
            clean_path = f'versions/{key}/{mode}.mp3'
            if clean_path in files and files[clean_path].get('size', 0) > 0:
                versions[mode] = {'path': clean_path}
        result[ref] = {'ref': ref, 'storage_key': key, 'original_id': original_id,
                       'original_path': path, 'original_hash': item.get('xetHash'),
                       'source_bytes': item.get('size'), 'versions': versions}
    return list(result.values())


class Registry:
    def __init__(self, site, token):
        parsed = urllib.parse.urlparse(site)
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
            raise ValueError('Registry must use HTTPS (localhost is allowed for tests)')
        self.url = site.rstrip('/') + '/api/versions'
        self.token = token

    def call(self, action, **fields):
        request = urllib.request.Request(self.url, json.dumps({'action': action, **fields}).encode(),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'User-Agent': 'AuraVersionWorker/1.0'})
        # Only a DNS failure before sending is retried. A lost mutation response
        # recovers through leases and durable local outputs on the next run.
        try:
            with open_request(request, timeout=180) as response:
                return json.load(response)
        except urllib.error.HTTPError as cause:
            try:
                message = json.load(cause).get('error', 'Registry rejected request')
            except (ValueError, AttributeError):
                message = 'Registry rejected request'
            finally:
                cause.close()
            raise RuntimeError(f'{action}: HTTP {cause.code}: {message}') from None


class Ledger:
    def __init__(self, path):
        self.path = path
        with contextlib.closing(self.connect()) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS jobs (ref TEXT, source_hash TEXT, recipe TEXT, stage TEXT, error TEXT, updated INTEGER, PRIMARY KEY(ref, source_hash, recipe))')

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def record(self, job, recipe, stage, error=None):
        # SQLite's transaction context commits/rolls back but does not close
        # the connection. Close explicitly after every progress update.
        with contextlib.closing(self.connect()) as db, db:
            db.execute('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ref,source_hash,recipe) DO UPDATE SET stage=excluded.stage,error=excluded.error,updated=excluded.updated',
                (job['ref'], job['original_hash'], recipe, stage, error, int(time.time())))


def snapshot_recipe(work, executable):
    originals = {name: Path.home() / 'Library/Audio/Presets' / relative for name, relative in PRESETS.items()}
    hashes = {name: digest(path) for name, path in originals.items()}
    settings = {'aubatch': digest(executable), 'presets': hashes, 'format': 'mp3', 'bitrate': 320, 'target_peak': -1}
    recipe = 'aubatch-' + hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()
    folder = work / 'recipes' / recipe
    folder.mkdir(parents=True, exist_ok=True)
    snapshots = {}
    for name, original in originals.items():
        target = folder / f'{name}.aupreset'
        if not target.exists():
            shutil.copy2(original, target)
        if digest(target) != hashes[name]:
            raise ValueError('Preset snapshot differs from its recorded recipe')
        snapshots[name] = target
    atomic_json(folder / 'recipe.json', settings)
    return recipe, snapshots


def run_command(command, logfile, timeout=1800):
    with logfile.open('ab') as output:
        subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, check=True, timeout=timeout)


def probe_mp3(path, source_duration):
    data = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,bit_rate:format=duration', '-of', 'json', str(path)], timeout=60))
    duration = float(data['format']['duration'])
    stream = data['streams'][0]
    if stream['codec_name'] != 'mp3' or int(stream.get('bit_rate', 0)) != 320000 or not max(0, source_duration - 1) <= duration <= source_duration + 60:
        raise ValueError('Output codec, bitrate, or duration failed verification')
    return duration


def process_job(job, owner, registry, config, ledger, recipe, presets):
    ref = job['ref']
    folder = config['work'] / 'jobs' / job['storage_key'] / job['original_hash'] / recipe
    folder.mkdir(parents=True, exist_ok=True)
    source = folder / (job['storage_key'] + Path(job['original_path']).suffix)
    finished = threading.Event()
    lease_lost = threading.Event()

    def record(stage):
        ledger.record(job, recipe, stage)
        if config.get('report_progress'):
            try:
                registry.call('progress', ref=ref, owner=owner, stage=stage)
            except Exception:
                # Telemetry must not discard a valid render or upload. The
                # lease heartbeat remains the authority for publication.
                log(f'Progress report unavailable: {ref}; processing continues')

    def heartbeat():
        while not finished.wait(120):
            try:
                registry.call('heartbeat', ref=ref, owner=owner)
            except Exception:
                lease_lost.set()
                return

    keeper = threading.Thread(target=heartbeat, daemon=True)
    keeper.start()
    try:
        record('downloading')
        size = config['source_sizes'][job['original_path']]
        if not source.is_file() or source.stat().st_size != size:
            temporary = source.with_suffix(source.suffix + '.part')
            url = f"https://huggingface.co/buckets/{config['bucket']}/resolve/" + urllib.parse.quote(job['original_path'], safe='/')
            with open_request(urllib.request.Request(url, headers={'User-Agent': 'AuraVersionWorker/1.0'}), timeout=120) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            if temporary.stat().st_size != size:
                raise ValueError('Incomplete original download')
            os.replace(temporary, source)
        source_duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
            'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(source)], timeout=60).strip())
        if lease_lost.is_set():
            raise RuntimeError('Lease renewal failed')
        record('processing')
        rendered_files = {
            mode: folder / 'rendered' / suffix / f'{job["storage_key"]}_{suffix}.mp3'
            for mode, suffix in (('bass', 'BASS'), ('bass-reverb', 'BASS_REVERB'))
            if mode in job['missing']
        }
        reusable = bool(rendered_files) and all(path.is_file() for path in rendered_files.values())
        if reusable:
            try:
                for path in rendered_files.values():
                    probe_mp3(path, source_duration)
            except (ValueError, KeyError, IndexError, subprocess.SubprocessError):
                reusable = False
        command = [config['aubatch'], '--format', 'mp3', '--split-folders', '--mp3-bitrate', '320',
                   '--target-peak', '-1', '-q', '-o', str(folder / 'rendered')]
        for name, preset in presets.items():
            command.extend([f'--{name}-preset', str(preset)])
        command.append(str(source))
        if reusable:
            log(f'Reusing verified rendered files: {ref}')
        else:
            run_command(command, folder / 'aubatch.log', timeout=1800)
        publish = {}
        for mode in job['missing']:
            rendered = rendered_files[mode]
            duration = probe_mp3(rendered, source_duration)
            path = f'versions/{job["storage_key"]}/{mode}.mp3'
            staged = folder / 'upload' / mode
            staged.mkdir(parents=True, exist_ok=True)
            target = staged / f'{mode}.mp3'
            if not target.exists():
                try:
                    os.link(rendered, target)
                except OSError:
                    shutil.copy2(rendered, target)
            if digest(target) != digest(rendered):
                raise ValueError('Staged output differs from render')
            if lease_lost.is_set():
                raise RuntimeError('Lease renewal failed')
            record('uploading')
            # A separate single-song/mode staging directory lets hf sync resume
            # without uploading logs or overwriting a ready partner rendition.
            run_command(['hf', 'buckets', 'sync', str(staged),
                f'hf://buckets/{config["bucket"]}/versions/{job["storage_key"]}', '--no-delete'], folder / 'upload.log')
            publish[mode] = {'path': path, 'duration': duration, 'bytes': target.stat().st_size,
                             'sha256': digest(target), 'recipe': recipe}
        if lease_lost.is_set():
            raise RuntimeError('Lease renewal failed')
        record('publishing')
        registry.call('complete', ref=ref, owner=owner, versions=publish)
        ledger.record(job, recipe, 'ready')
        log(f'Ready: {ref} ({", ".join(publish)})')
        # Published audio remains in HF; only temporary files from this exact
        # completed job are removed. Its logs, recipe and ledger are retained.
        for temporary in (source, folder / 'rendered', folder / 'upload'):
            if temporary.is_dir():
                shutil.rmtree(temporary)
            else:
                temporary.unlink(missing_ok=True)
        return True
    except Exception as cause:
        message = f'{type(cause).__name__}: {cause}'
        ledger.record(job, recipe, 'failed', message)
        log(f'Failed: {ref}: {message}; files retained for retry')
        with contextlib.suppress(Exception):
            registry.call('fail', ref=ref, owner=owner, error=message)
        return False
    finally:
        finished.set()
        keeper.join(timeout=2)


def scan(config, registry, dry_run=False):
    tree = read_tree(config['bucket'])
    moves = []
    if not dry_run and config.get('organize', True):
        # Future GitHub uploads may still arrive at the root. Normalize only
        # originals/covers here; the one-time script handles existing renditions.
        moves = [move for move in plan_layout(tree) if move['target'].startswith(('originals/', 'covers/'))]
        if moves:
            copy_plan(config['bucket'], moves)
            tree = read_tree(config['bucket'])
            verify_plan(tree, moves)
            registry.call('reconcile')  # refresh the edge's archive snapshot
    rows = inventory(tree)
    config['source_sizes'] = {row['original_path']: row['source_bytes'] for row in rows}
    if dry_run:
        ready = sum(len(row['versions']) for row in rows)
        log(f'Read-only archive scan: {len(rows)} originals, {ready} attached files, {len(rows) * 2 - ready} absent files')
        return rows
    for offset in range(0, len(rows), 20):
        registry.call('sync', tracks=rows[offset:offset + 20])
    if moves:
        prune_plan(config['bucket'], read_tree(config['bucket']), moves)
        log(f'Organized {len(moves)} new originals/covers with verified server-side copies')
    registry.call('reconcile')
    log(f'Registry synced: {registry.call("status")}')
    return rows


def drain(config, registry, ledger, recipe, presets, limit=None):
    if STOP.is_set():
        return 0, 0
    config = dict(config)
    owner = str(uuid.uuid4())
    attempted = failed = 0
    run_error = None
    try:
        registry.call('runStarted', owner=owner, host=socket.gethostname()[:100],
                      parallelism=config['jobs'], recipe=recipe)
        config['report_progress'] = True
    except Exception:
        config['report_progress'] = False
        log('Admin run reporting unavailable; processing continues with the local ledger')
    try:
        with ThreadPoolExecutor(max_workers=config['jobs']) as pool:
            # Each lane continually downloads/renders/uploads, and claims its
            # next song independently; a slow render does not block the batch.
            def lane():
                nonlocal attempted, failed
                while not STOP.is_set():
                    with claim_lock:
                        if limit is not None and attempted >= limit:
                            return
                        jobs = registry.call('claim', owner=owner, limit=1)['tracks']
                        if not jobs:
                            return
                        attempted += 1
                    ok = process_job(jobs[0], owner, registry, config, ledger, recipe, presets)
                    if not ok:
                        with claim_lock:
                            failed += 1
            claim_lock = threading.Lock()
            futures = [pool.submit(lane) for _ in range(config['jobs'])]
            for future in as_completed(futures):
                future.result()
    except Exception as cause:
        run_error = f'{type(cause).__name__}: {cause}'
        raise
    finally:
        if config['report_progress']:
            with contextlib.suppress(Exception):
                registry.call('runFinished', owner=owner, attempted=attempted, failed=failed,
                              status='stopped' if STOP.is_set() else 'failed' if failed or run_error else 'complete',
                              error=run_error)
    return attempted, failed


def load_config(path):
    path = path.expanduser().resolve()
    raw = json.loads(path.read_text())
    token_path = Path(raw['token_file']).expanduser()
    if token_path.stat().st_mode & 0o077:
        raise ValueError('Worker token file must have permissions 0600')
    token = token_path.read_text().strip()
    if len(token) < 32:
        raise ValueError('Worker token is too short')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', raw.get('bucket', 'Angelrider/sonora')):
        raise ValueError('Invalid bucket')
    raw['bucket'] = raw.get('bucket', 'Angelrider/sonora')
    raw['work'] = Path(raw.get('work_dir', '~/.local/share/aura-music/version-worker')).expanduser().resolve()
    raw['aubatch'] = str(Path(raw.get('aubatch', shutil.which('aubatch') or '/opt/homebrew/bin/aubatch')).resolve())
    raw['jobs'] = raw.get('jobs', 4)
    if not isinstance(raw['jobs'], int) or not 1 <= raw['jobs'] <= 4:
        raise ValueError('Use 1–4 processing workers')
    return raw, token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home() / '.config/aura-music/version-worker.json')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true', help='Drain eligible work and exit (default)')
    mode.add_argument('--watch', action='store_true', help='Keep checking for new songs')
    mode.add_argument('--dry-run', action='store_true', help='Read-only scan; no jobs, rendering or uploads')
    mode.add_argument('--status', action='store_true', help='Show private database counts and exit')
    mode.add_argument('--sync-only', action='store_true', help='Import archive metadata without processing')
    parser.add_argument('--limit', type=int, help='Maximum songs per run (useful for a first test)')
    parser.add_argument('--interval', type=int, default=300)
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1 or args.interval < 30:
        parser.error('Limit must be positive and interval at least 30 seconds')
    try:
        config, token = load_config(args.config)
        ensure_file_capacity()
        registry = Registry(config['site'], token)
        if args.status:
            print(json.dumps(registry.call('status'), indent=2))
            return 0
        if args.dry_run:
            scan(config, registry, True)
            return 0
        config['work'].mkdir(parents=True, exist_ok=True, mode=0o700)
        with (config['work'] / 'worker.lock').open('w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log('Another local worker is already running')
                return 0
            signal.signal(signal.SIGINT, lambda *_: STOP.set())
            signal.signal(signal.SIGTERM, lambda *_: STOP.set())
            if args.sync_only:
                scan(config, registry)
                return 0
            for tool in (config['aubatch'], 'ffmpeg', 'ffprobe', 'hf'):
                if not shutil.which(tool):
                    raise ValueError(f'Required executable missing: {tool}')
            ledger = Ledger(config['work'] / 'jobs.sqlite')
            recipe, presets = snapshot_recipe(config['work'], config['aubatch'])
            failed = 0
            while not STOP.is_set():
                try:
                    scan(config, registry)
                    attempted, failed = drain(config, registry, ledger, recipe, presets, args.limit)
                    log(f'Run finished: {attempted} songs attempted, {failed} failures')
                except Exception as cause:
                    if not args.watch:
                        raise
                    failed = 1
                    log(f'Scan/run unavailable: {type(cause).__name__}: {cause}; retrying later')
                if not args.watch:
                    break
                STOP.wait(args.interval)
            return 1 if failed else 0
    except Exception as cause:
        log(f'Worker stopped: {type(cause).__name__}: {cause}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
