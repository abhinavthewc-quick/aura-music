#!/usr/bin/env python3
"""Install a repo-backed launcher. Keep credentials and runtime data private."""
import argparse
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def install(bin_dir, config_dir, data_dir):
    source = ROOT / 'bin' / 'aura-version-worker'
    bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / source.name
    linked = launcher.is_symlink() and launcher.resolve() == source
    if launcher.exists() and launcher.is_dir():
        raise ValueError('Launcher destination is a directory')
    if not linked and (launcher.exists() or launcher.is_symlink()):
        backups = data_dir / 'install-backups'
        backups.mkdir(parents=True, exist_ok=True, mode=0o700)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        shutil.copy2(launcher, backups / f'aura-version-worker-{stamp}', follow_symlinks=False)
        launcher.unlink()
    if not linked:
        launcher.symlink_to(source)
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = config_dir / 'version-worker.json'
    if not config.exists():
        example = json.loads((ROOT / 'config' / 'version-worker.example.json').read_text())
        example['token_file'] = str(config_dir / 'version-worker.token')
        example['work_dir'] = str(data_dir / 'version-worker')
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(example, output, indent=2)
            output.write('\n')
    return launcher


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    parser.add_argument('--config-dir', type=Path, default=Path.home() / '.config/aura-music')
    parser.add_argument('--data-dir', type=Path, default=Path.home() / '.local/share/aura-music')
    args = parser.parse_args()
    launcher = install(args.bin_dir.expanduser(),args.config_dir.expanduser(),args.data_dir.expanduser())
    print(f'Installed {launcher} -> {launcher.resolve()}')
    print('Existing configuration, credentials and jobs are preserved. No background service installed.')


if __name__ == '__main__':
    main()
