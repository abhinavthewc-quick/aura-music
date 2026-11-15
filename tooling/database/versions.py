#!/usr/bin/env python3
"""Inspect, back up or migrate the version D1 database using Wrangler auth."""
import argparse
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def backup(command, directory):
    directory = directory.expanduser().resolve()
    if directory == ROOT or ROOT in directory.parents:
        raise ValueError('Database backups must stay outside the repository')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = directory / f'audio-versions-{stamp}.sql'
    previous = os.umask(0o077)
    try:
        # Wrangler prints a temporary signed download URL; keep it private.
        subprocess.run([*command[:2],'export',*command[2:],'--remote','--output',str(target)],
                       check=True,cwd=ROOT,capture_output=True,text=True)
        target.chmod(0o600)
    finally:
        os.umask(previous)
    print(f'D1 backup saved to {target}')
    return target


def migrate(command, directory):
    backup(command,directory)
    # The older initial migration belongs to a separate experiment database.
    for name in ('002_audio_versions.sql','003_audio_processing_admin.sql'):
        subprocess.run([*command[:2],'execute',*command[2:],'--remote','--yes','--file',str(ROOT/'migrations'/name)],check=True,cwd=ROOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('status','backup','migrate'))
    parser.add_argument('--config',type=Path,default=ROOT/'tooling/config/wrangler.versions.json')
    parser.add_argument('--database',default='aura-audio-versions')
    parser.add_argument('--backup-dir',type=Path,default=Path.home()/'.local/share/aura-music/db-backups')
    parser.add_argument('--wrangler',default=shutil.which('wrangler') or 'wrangler')
    args = parser.parse_args()
    prefix = [args.wrangler,'d1']
    suffix = [args.database,'--config',str(args.config.expanduser().resolve())]
    # Subprocess list arguments preserve paths containing spaces.
    command = [*prefix,args.database,'--config',str(args.config.expanduser().resolve())]
    if args.action == 'status':
        subprocess.run([*prefix,'execute',*suffix,'--remote','--command',
            "SELECT COUNT(*) AS tracks FROM audio_tracks WHERE active = 1; SELECT r.status, COUNT(*) AS count FROM audio_renditions r JOIN audio_tracks t ON t.ref=r.track_ref WHERE t.active=1 GROUP BY r.status;"],check=True,cwd=ROOT)
    elif args.action == 'backup':
        backup(command,args.backup_dir)
    else:
        migrate(command,args.backup_dir)


if __name__ == '__main__':
    main()
