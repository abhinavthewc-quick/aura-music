#!/usr/bin/env python3
"""Compatibility launcher for the repository-owned OCI cache tools."""
import runpy
import sys
from pathlib import Path

source=Path(__file__).resolve().parents[1]/'tooling/cache/oci_cache.py'
sys.path.insert(0,str(source.parent))
args=sys.argv[1:]
if '--prune' in args:
    raise SystemExit('Eviction now happens automatically inside the managed Aura cache prefix.')
action='status' if '--status' in args else 'warm'
args=[argument for argument in args if argument!='--status']
args=['--path' if argument=='--track' else argument for argument in args]
sys.argv=[str(source),action,*args]
runpy.run_path(str(source),run_name='__main__')
