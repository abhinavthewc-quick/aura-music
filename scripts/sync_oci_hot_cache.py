#!/usr/bin/env python3
"""Sync hot/most-played tracks from Hugging Face into Oracle Cloud Infrastructure (OCI)

Object Storage (Bucket 'Kalam', Hyderabad region 'ap-hyderabad-1').

Safety Features:
- Hard capacity cap: max 30 tracks (~200 MB), staying under 3% of Oracle's 10 GB Free Tier.
- Automatic pruning / deletion of old tracks when at capacity.
- Bucket inspection / health status command (--status).
- Size limits: files > 25 MB are skipped.
"""
import argparse
import datetime
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional

OCI_NAMESPACE = os.getenv("OCI_NAMESPACE", "ax6entau0azm")
OCI_BUCKET_NAME = os.getenv("OCI_BUCKET_NAME", "Kalam")
OCI_REGION = os.getenv("OCI_REGION", "ap-hyderabad-1")
OCI_ACCESS_KEY = os.getenv("OCI_ACCESS_KEY", "327b856340046407370e32d81faf18ae3259ef00")
OCI_SECRET_KEY = os.getenv("OCI_SECRET_KEY", "lvBFujZc9f+Kx+2EHNKI62gJQrhgjnDKDFdm5dh3qxI=")
HF_BUCKET_ID = os.getenv("HF_BUCKET_ID", "Angelrider/sonora")

MAX_SAFE_TRACKS = 30
MAX_SAFE_FILE_SIZE = 25 * 1024 * 1024  # 25 MB
ORACLE_FREE_TIER_MB = 10240  # 10 GB


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sign_oci_request(method: str, object_key: str = "", body: bytes = b"") -> urllib.request.Request:
    host = f"{OCI_NAMESPACE}.compat.objectstorage.{OCI_REGION}.oraclecloud.com"
    clean_key = object_key.lstrip("/")
    endpoint = (
        f"https://{host}/{OCI_BUCKET_NAME}/{urllib.parse.quote(clean_key)}"
        if clean_key
        else f"https://{host}/{OCI_BUCKET_NAME}/"
    )

    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    canonical_uri = (
        f"/{OCI_BUCKET_NAME}/{urllib.parse.quote(clean_key)}"
        if clean_key
        else f"/{OCI_BUCKET_NAME}/"
    )
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

    return urllib.request.Request(
        endpoint,
        data=body if method == "PUT" else None,
        method=method,
        headers=req_headers,
    )


def list_oci_objects() -> List[Dict]:
    req = sign_oci_request("GET", "")
    with urllib.request.urlopen(req) as resp:
        xml_data = resp.read().decode("utf-8")
    root = ET.fromstring(xml_data)
    objects = []
    for elem in root.iter():
        if elem.tag.endswith("Contents"):
            key_el = None
            size_el = None
            date_el = None
            for child in elem:
                if child.tag.endswith("Key"):
                    key_el = child
                elif child.tag.endswith("Size"):
                    size_el = child
                elif child.tag.endswith("LastModified"):
                    date_el = child
            if key_el is not None and key_el.text:
                objects.append({
                    "key": key_el.text,
                    "size": int(size_el.text) if size_el is not None and size_el.text else 0,
                    "last_modified": date_el.text if date_el is not None and date_el.text else "",
                })
    return objects


def delete_oci_object(object_key: str) -> bool:
    clean_key = object_key.lstrip("/")
    try:
        req = sign_oci_request("DELETE", clean_key)
        with urllib.request.urlopen(req) as resp:
            return resp.status in (200, 204)
    except Exception as e:
        print(f"✗ Failed to delete {clean_key}: {e}")
        return False


def prune_bucket_if_needed(max_tracks: int = MAX_SAFE_TRACKS):
    objects = list_oci_objects()
    if len(objects) < max_tracks:
        return

    # Sort oldest first
    objects.sort(key=lambda x: x.get("last_modified", ""))
    excess = (len(objects) - max_tracks) + 1
    print(f"⚠️ Bucket has {len(objects)} tracks (cap is {max_tracks}). Pruning {excess} oldest track(s)...")

    for i in range(min(excess, len(objects))):
        target = objects[i]
        print(f"  🗑️ Evicting: {target['key']} ({target['size'] / (1024*1024):.2f} MB)")
        delete_oci_object(target["key"])


def print_bucket_status():
    print("=" * 70)
    print(f"📦 OCI OBJECT STORAGE STATUS: [{OCI_NAMESPACE}] Bucket '{OCI_BUCKET_NAME}'")
    print(f"   Region: {OCI_REGION}")
    print("=" * 70)
    try:
        objects = list_oci_objects()
        total_bytes = sum(o["size"] for o in objects)
        total_mb = total_bytes / (1024 * 1024)
        pct_free = (total_mb / ORACLE_FREE_TIER_MB) * 100

        print(f"Total Cached Tracks: {len(objects)} / {MAX_SAFE_TRACKS} (Safety Cap)")
        print(f"Total Storage Used:  {total_mb:.2f} MB / {ORACLE_FREE_TIER_MB} MB ({pct_free:.3f}% of 10 GB Free Tier)")
        print(f"Free Tier Headroom:  {ORACLE_FREE_TIER_MB - total_mb:.2f} MB permanently safe\n")

        if objects:
            print(f"{'#':<3} {'Track Filename':<52} {'Size':<10} {'Last Modified'}")
            print("-" * 85)
            for idx, o in enumerate(objects, 1):
                key = o["key"]
                short_key = (key[:49] + "...") if len(key) > 52 else key
                size_mb = f"{o['size'] / (1024*1024):.2f} MB"
                print(f"{idx:<3} {short_key:<52} {size_mb:<10} {o['last_modified']}")
        else:
            print("Bucket is currently empty.")
    except Exception as e:
        print(f"✗ Could not retrieve bucket status: {e}")
    print("=" * 70)


def check_object_exists(object_key: str) -> bool:
    try:
        req = sign_oci_request("HEAD", object_key)
        with urllib.request.urlopen(req) as resp:
            return resp.status in (200, 206)
    except urllib.error.HTTPError as e:
        return False
    except Exception:
        return False


def upload_track_to_oci(track_path: str, max_tracks: int = MAX_SAFE_TRACKS) -> bool:
    clean_path = track_path.lstrip("/")

    # Path safety checks
    if ".." in clean_path or "\\" in clean_path:
        print(f"✗ Refusing invalid track path: {clean_path}")
        return False

    if check_object_exists(clean_path):
        print(f"✓ Already cached in OCI Kalam: {clean_path}")
        return True

    # Prune before adding if at capacity
    prune_bucket_if_needed(max_tracks)

    hf_url = f"https://huggingface.co/buckets/{HF_BUCKET_ID}/resolve/{urllib.parse.quote(clean_path)}"
    print(f"↓ Downloading from Hugging Face: {clean_path} ...")
    try:
        req_hf = urllib.request.Request(hf_url, headers={"User-Agent": "AuraMusic/1.0"})
        with urllib.request.urlopen(req_hf) as resp:
            data = resp.read()
    except Exception as e:
        print(f"✗ Failed to download from Hugging Face: {e}")
        return False

    if len(data) > MAX_SAFE_FILE_SIZE:
        print(f"✗ Track exceeds safe limit ({len(data)/(1024*1024):.1f} MB > 25 MB). Skipping.")
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
    parser = argparse.ArgumentParser(description="Manage & Sync OCI Object Storage Kalam bucket safely")
    parser.add_argument("--status", action="store_true", help="Display current bucket storage usage and tracks")
    parser.add_argument("--prune", action="store_true", help="Prune bucket to fit within --limit")
    parser.add_argument("--track", type=str, help="Single track path to cache")
    parser.add_argument("--limit", type=int, default=MAX_SAFE_TRACKS, help=f"Max tracks to cache (default: {MAX_SAFE_TRACKS})")
    args = parser.parse_args()

    if args.status:
        print_bucket_status()
        return

    if args.prune:
        prune_bucket_if_needed(args.limit)
        print_bucket_status()
        return

    print(f"OCI Hot-Cache Target: [{OCI_NAMESPACE}] Bucket '{OCI_BUCKET_NAME}' ({OCI_REGION})")
    print(f"Safety Cap: Max {args.limit} tracks (~{args.limit * 7} MB out of 10,000 MB Free Tier)")

    if args.track:
        upload_track_to_oci(args.track, max_tracks=args.limit)
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
        if upload_track_to_oci(path, max_tracks=args.limit):
            cached_count += 1

    print(f"\nDone! {cached_count}/{min(len(audios), args.limit)} tracks verified in OCI Kalam.")
    print_bucket_status()


if __name__ == "__main__":
    main()
