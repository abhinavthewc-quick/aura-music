#!/usr/bin/env python3
"""Sync hot/most-played tracks from Hugging Face into Oracle Cloud Infrastructure (OCI)

Object Storage (Bucket 'Kalam', Hyderabad region 'ap-hyderabad-1').
"""
import os
import sys
import argparse
import urllib.request
import urllib.parse
import hmac
import hashlib
import datetime
from typing import List, Optional

OCI_NAMESPACE = os.getenv("OCI_NAMESPACE", "ax6entau0azm")
OCI_BUCKET_NAME = os.getenv("OCI_BUCKET_NAME", "Kalam")
OCI_REGION = os.getenv("OCI_REGION", "ap-hyderabad-1")
OCI_ACCESS_KEY = os.getenv("OCI_ACCESS_KEY", "327b856340046407370e32d81faf18ae3259ef00")
OCI_SECRET_KEY = os.getenv("OCI_SECRET_KEY", "lvBFujZc9f+Kx+2EHNKI62gJQrhgjnDKDFdm5dh3qxI=")
HF_BUCKET_ID = os.getenv("HF_BUCKET_ID", "Angelrider/sonora")


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sign_oci_request(method: str, object_key: str, body: bytes = b"") -> urllib.request.Request:
    host = f"{OCI_NAMESPACE}.compat.objectstorage.{OCI_REGION}.oraclecloud.com"
    clean_key = object_key.lstrip("/")
    endpoint = f"https://{host}/{OCI_BUCKET_NAME}/{urllib.parse.quote(clean_key)}"

    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    canonical_uri = f"/{OCI_BUCKET_NAME}/{urllib.parse.quote(clean_key)}"
    headers = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if method == "PUT" and body:
        headers["content-length"] = str(len(body))

    sorted_keys = sorted(headers.keys())
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted_keys)
    signed_headers = ";".join(sorted_keys)

    canonical_request = f"{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    credential_scope = f"{date_stamp}/{OCI_REGION}/s3/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"

    k_date = sign(f"AWS4{OCI_SECRET_KEY}".encode("utf-8"), date_stamp)
    k_region = sign(k_date, OCI_REGION)
    k_service = sign(k_region, "s3")
    k_signing = sign(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth_header = f"AWS4-HMAC-SHA256 Credential={OCI_ACCESS_KEY}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"

    req_headers = {
        "Host": host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
        "Authorization": auth_header,
    }
    if method == "PUT" and body:
        req_headers["Content-Length"] = str(len(body))

    return urllib.request.Request(endpoint, data=body if method == "PUT" else None, method=method, headers=req_headers)


def check_object_exists(object_key: str) -> bool:
    try:
        req = sign_oci_request("HEAD", object_key)
        with urllib.request.urlopen(req) as resp:
            return resp.status in (200, 206)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        return False
    except Exception:
        return False


def upload_track_to_oci(track_path: str) -> bool:
    clean_path = track_path.lstrip("/")
    if check_object_exists(clean_path):
        print(f"✓ Already cached in OCI Kalam: {clean_path}")
        return True

    hf_url = f"https://huggingface.co/buckets/{HF_BUCKET_ID}/resolve/{urllib.parse.quote(clean_path)}"
    print(f"↓ Downloading from Hugging Face: {clean_path} ...")
    try:
        req_hf = urllib.request.Request(hf_url, headers={"User-Agent": "AuraMusic/1.0"})
        with urllib.request.urlopen(req_hf) as resp:
            data = resp.read()
    except Exception as e:
        print(f"✗ Failed to download from Hugging Face: {e}")
        return False

    print(f"↑ Uploading {len(data) / (1024*1024):.2f} MB to OCI Kalam (Hyderabad)...")
    try:
        put_req = sign_oci_request("PUT", clean_path, body=data)
        with urllib.request.urlopen(put_req) as resp:
            if resp.status in (200, 201):
                print(f"✓ Successfully cached in OCI Kalam: {clean_path}")
                return True
            else:
                print(f"✗ OCI PUT returned HTTP {resp.status}")
                return False
    except Exception as e:
        print(f"✗ OCI Upload failed: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Sync tracks to OCI Object Storage Kalam bucket")
    parser.add_argument("--track", type=str, help="Single track path to cache")
    parser.add_argument("--limit", type=int, default=10, help="Max tracks to cache")
    args = parser.parse_args()

    print(f"OCI Hot-Cache Target: [{OCI_NAMESPACE}] Bucket '{OCI_BUCKET_NAME}' ({OCI_REGION})")

    if args.track:
        upload_track_to_oci(args.track)
        return

    # Fetch bucket tree from Hugging Face to get audio paths
    tree_url = f"https://huggingface.co/api/buckets/{HF_BUCKET_ID}/tree"
    print(f"Fetching catalog tree from Hugging Face: {HF_BUCKET_ID} ...")
    try:
        req = urllib.request.Request(tree_url, headers={"User-Agent": "AuraMusic/1.0"})
        with urllib.request.urlopen(req) as resp:
            import json
            items = json.loads(resp.read().decode())
    except Exception as e:
        print(f"Could not read tree from Hugging Face: {e}")
        sys.exit(1)

    audios = [it["path"] for it in items if isinstance(it, dict) and it.get("path", "").endswith((".mp3", ".opus", ".m4a", ".webm"))]
    print(f"Found {len(audios)} audio files in catalog. Pre-warming top {args.limit} tracks...")

    cached_count = 0
    for path in audios[:args.limit]:
        if upload_track_to_oci(path):
            cached_count += 1

    print(f"\nDone! {cached_count}/{min(len(audios), args.limit)} tracks verified in OCI Kalam.")


if __name__ == "__main__":
    main()
