#!/usr/bin/env python3
"""Check OCI, inspect cache status, warm songs or benchmark through the proxy."""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from oci_client import DEFAULT_CONFIG, admin_token, check_bucket, load_config
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'audio'))
from audio_version_worker import inventory, public_json, read_tree


def request_audio(config,path,method='GET',byte_range='bytes=0-0'):
    url = config['site'].rstrip('/')+'/api/audio?path='+urllib.parse.quote(path,safe='')+'&cache=2'
    headers = {'User-Agent':'AuraCacheTools/1.0'}
    if method=='GET':
        headers['Range'] = byte_range
    return urllib.request.Request(url,method=method,headers=headers)


def warm(config,path,timeout=90):
    with urllib.request.urlopen(request_audio(config,path),timeout=30) as response:
        response.read(2)
        if response.status!=206:
            raise ValueError('Expected a byte-range response')
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        with urllib.request.urlopen(request_audio(config,path,'HEAD'),timeout=30) as response:
            if response.headers.get('x-aura-cache')=='HIT-OCI':
                return {'path':path,'cache':'HIT-OCI'}
        time.sleep(3)
    raise TimeoutError('OCI warming did not finish; check configuration/status')


def targets(config,paths,limit):
    if paths:
        return list(dict.fromkeys(paths))
    bucket=config.get('hf_bucket','Angelrider/sonora')
    registry=public_json(config['site'].rstrip('/')+'/api/versions')
    if registry.get('source')!='database':
        raise ValueError('A D1-backed catalogue is required')
    result=[]
    for track in inventory(read_tree(bucket))[:limit]:
        result.append(track['original_path'])
        result.extend(file['path'] for file in registry['tracks'].get(track['ref'],{}).values())
    return result


def benchmark(config,path,runs):
    hf='https://huggingface.co/buckets/'+config.get('hf_bucket','Angelrider/sonora')+'/resolve/'+urllib.parse.quote(path,safe='/')
    result={}
    for name in ('proxy','huggingface'):
        samples=[]
        for _ in range(runs):
            request=request_audio(config,path,byte_range='bytes=0-262143') if name=='proxy' else urllib.request.Request(hf,headers={'Range':'bytes=0-262143','User-Agent':'AuraCacheTools/1.0'})
            start=time.perf_counter()
            with urllib.request.urlopen(request,timeout=30) as response:
                first_byte=(time.perf_counter()-start)*1000
                count=len(response.read(262145))
                if response.status!=206 or count>262144:
                    raise ValueError('Benchmark requires bounded byte-range streaming')
                samples.append({'ttfb_ms':round(first_byte,2),'total_ms':round((time.perf_counter()-start)*1000,2),'bytes':count,'cache':response.headers.get('x-aura-cache')})
        result[name]=samples
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('check','status','warm','benchmark'))
    parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    parser.add_argument('--path',action='append',default=[])
    parser.add_argument('--limit',type=int,default=1,help='Songs for manual warming; 1–10, including available versions')
    parser.add_argument('--timeout',type=int,default=90)
    parser.add_argument('--runs',type=int,default=3)
    args=parser.parse_args()
    if not 1<=args.limit<=10 or not 1<=args.runs<=10 or not 1<=args.timeout<=300:
        parser.error('Use 1–10 songs/runs and a timeout from 1–300 seconds')
    try:
        config=load_config(args.config,credentials=args.action=='check')
        if args.action=='check':
            result=check_bucket(config)
        elif args.action=='status':
            request=urllib.request.Request(config['site'].rstrip('/')+'/api/audio?action=status',headers={'Authorization':'Bearer '+admin_token(config),'User-Agent':'AuraCacheTools/1.0'})
            with urllib.request.urlopen(request,timeout=30) as response:
                result=json.load(response)
        elif args.action=='warm':
            paths=targets(config,args.path,args.limit)
            if not paths:
                raise ValueError('No catalogue audio found')
            with ThreadPoolExecutor(max_workers=3) as pool:
                result=list(pool.map(lambda path:warm(config,path,args.timeout),paths))
        else:
            if len(args.path)!=1:
                raise ValueError('Benchmark requires one --path')
            result=benchmark(config,args.path[0],args.runs)
        print(json.dumps(result,indent=2))
        return 0
    except Exception as error:
        # Never render provider bodies, signed headers or configuration values.
        print(f'Cache tool failed: {type(error).__name__}',file=sys.stderr)
        if isinstance(error,ValueError):
            print(str(error),file=sys.stderr)
        return 1


if __name__=='__main__':
    sys.exit(main())
