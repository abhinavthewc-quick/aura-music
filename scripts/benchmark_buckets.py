#!/usr/bin/env python3
"""Compatibility launcher; benchmark a chosen path through the current proxy."""
import runpy
import sys
from pathlib import Path

source=Path(__file__).resolve().parents[1]/'tooling/cache/oci_cache.py'
sys.path.insert(0,str(source.parent))
sys.argv=[str(source),'benchmark',*sys.argv[1:]]
runpy.run_path(str(source),run_name='__main__')
