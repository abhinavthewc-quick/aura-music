#!/usr/bin/env python3
"""Validate OCI access and install only Aura cache secrets using Wrangler."""
import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from oci_client import DEFAULT_CONFIG, FIELDS, admin_token, check_bucket, load_config


def initialize(path):
    path=Path(path).expanduser()
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if not path.exists():
        config=json.loads((Path(__file__).resolve().parents[1]/'config/oci-cache.example.json').read_text())
        config['admin_token_file']=str(path.parent/'audio-cache-admin.token')
        descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'w') as output:
            json.dump(config,output,indent=2)
            output.write('\n')
    config=load_config(path)
    token=Path(config['admin_token_file']).expanduser()
    token.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if not token.exists():
        descriptor=os.open(token,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'w') as output:
            output.write(secrets.token_hex(32)+'\n')
    return path


def activate(config,wrangler='wrangler'):
    # A failed OCI access check must leave all Pages configuration untouched.
    check_bucket(config)
    values={key:config[key] for key in FIELDS}
    values['AUDIO_ADMIN_TOKEN']=admin_token(config)
    project=config.get('project','aura-music')
    for environment in ('production','preview'):
        # Audited Wrangler bulk operation patches only supplied keys. It does
        # not echo existing redacted secrets back into Cloudflare settings.
        subprocess.run([wrangler,'pages','secret','bulk','--project-name',project,'--env',environment],
            input=json.dumps(values),text=True,capture_output=True,check=True)
        print(f'Configured {len(values)} cache secrets for {environment}')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    parser.add_argument('--activate',action='store_true',help='Explicitly install verified cache secrets; redeploy afterward')
    parser.add_argument('--init',action='store_true',help='Create private config/token files without overwriting existing settings')
    parser.add_argument('--wrangler',default=shutil.which('wrangler') or 'wrangler')
    args=parser.parse_args()
    try:
        if args.init:
            if args.activate:
                parser.error('Initialize and fill credentials before activation')
            print(f'Private cache configuration: {initialize(args.config)}')
            return 0
        config=load_config(args.config,credentials=True)
        if args.activate:
            activate(config,args.wrangler)
        else:
            print(json.dumps(check_bucket(config)))
        return 0
    except Exception as error:
        print(f'Cache configuration failed: {type(error).__name__}',file=sys.stderr)
        if isinstance(error,ValueError):
            print(str(error),file=sys.stderr)
        return 1


if __name__=='__main__':
    sys.exit(main())
