"""OCI S3 request signing and private configuration; no embedded credentials."""
import hashlib
import hmac
import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

FIELDS = ('OCI_NAMESPACE','OCI_BUCKET_NAME','OCI_REGION','OCI_ACCESS_KEY','OCI_SECRET_KEY')
DEFAULT_CONFIG = Path.home()/'.config/aura-music/oci-cache.json'


def load_config(path=DEFAULT_CONFIG, credentials=False):
    path = Path(path).expanduser()
    if path.stat().st_mode & 0o077:
        raise ValueError('OCI configuration must have permissions 0600')
    config = json.loads(path.read_text())
    if credentials:
        missing = [key for key in FIELDS if not isinstance(config.get(key),str) or not config[key].strip()]
        if missing:
            raise ValueError('Missing configuration: '+', '.join(missing))
        for key in FIELDS:
            config[key] = config[key].strip()
        if not re.fullmatch(r'[a-zA-Z0-9]{1,63}',config['OCI_NAMESPACE']) or not re.fullmatch(r'[a-zA-Z0-9-]{1,63}',config['OCI_REGION']):
            raise ValueError('Invalid OCI namespace/region')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}',config['OCI_BUCKET_NAME']):
            raise ValueError('Invalid OCI bucket')
        if any(re.search(r'\s',config[key]) for key in ('OCI_ACCESS_KEY','OCI_SECRET_KEY')):
            raise ValueError('OCI credentials contain whitespace')
    site = urllib.parse.urlparse(config.get('site',''))
    if site.scheme != 'https' or not site.hostname or site.username or site.password:
        raise ValueError('Site must be an HTTPS URL without credentials')
    return config


def admin_token(config):
    path = Path(config['admin_token_file']).expanduser()
    if path.stat().st_mode & 0o077:
        raise ValueError('Cache admin token must have permissions 0600')
    token = path.read_text().strip()
    if len(token)<32:
        raise ValueError('Cache admin token is too short')
    return token


def cache_prefix(bucket='Angelrider/sonora'):
    return 'aura-cache/v2/'+hashlib.sha256(bucket.encode()).hexdigest()[:20]+'/'


def signed_request(config, method='GET', path='', query=None, now=None):
    if method not in ('GET','HEAD'):
        raise ValueError('This client supports read-only OCI checks')
    if re.search(r'[\\\x00-\x1f\x7f]',path) or any(part in ('.','..') for part in path.split('/')):
        raise ValueError('Invalid object path')
    quote = lambda text: urllib.parse.quote(str(text),safe='-_.~')
    host = f'{config["OCI_NAMESPACE"]}.compat.objectstorage.{config["OCI_REGION"]}.oraclecloud.com'
    uri = '/'+quote(config['OCI_BUCKET_NAME'])+'/'+ '/'.join(quote(part) for part in path.split('/'))
    canonical_query = '&'.join(f'{quote(key)}={quote(value)}' for key,value in sorted((query or {}).items()))
    date = (now or datetime.now(timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    payload = hashlib.sha256(b'').hexdigest()
    headers = {'host':host,'x-amz-content-sha256':payload,'x-amz-date':date}
    names = ';'.join(sorted(headers))
    canonical_headers = ''.join(f'{key}:{headers[key]}\n' for key in sorted(headers))
    canonical = '\n'.join([method,uri,canonical_query,canonical_headers,names,payload])
    scope = f'{date[:8]}/{config["OCI_REGION"]}/s3/aws4_request'
    message = '\n'.join(['AWS4-HMAC-SHA256',date,scope,hashlib.sha256(canonical.encode()).hexdigest()])
    key = ('AWS4'+config['OCI_SECRET_KEY']).encode()
    for value in (date[:8],config['OCI_REGION'],'s3','aws4_request'):
        key = hmac.new(key,value.encode(),hashlib.sha256).digest()
    signature = hmac.new(key,message.encode(),hashlib.sha256).hexdigest()
    headers['Authorization'] = f'AWS4-HMAC-SHA256 Credential={config["OCI_ACCESS_KEY"]}/{scope}, SignedHeaders={names}, Signature={signature}'
    url = f'https://{host}{uri}'+('?'+canonical_query if canonical_query else '')
    return urllib.request.Request(url,method=method,headers=headers)


def check_bucket(config):
    request = signed_request(config,query={'max-keys':'1','prefix':cache_prefix(config.get('hf_bucket','Angelrider/sonora'))})
    with urllib.request.urlopen(request,timeout=20) as response:
        root = ET.fromstring(response.read())
    if root.tag.split('}')[-1] != 'ListBucketResult':
        raise ValueError('Unexpected OCI listing')
    return {'oci_access':'verified','bucket':config['OCI_BUCKET_NAME'],'region':config['OCI_REGION']}
