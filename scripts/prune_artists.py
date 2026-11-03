#!/usr/bin/env python3
"""
Prune Michael Jackson and The Weeknd files and manifest entries from Hugging Face Bucket.
Usage:
    python scripts/prune_artists.py [--dry-run]
Requires:
    HF_TOKEN environment variable (or passed via GitHub Actions secrets).
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HF_BUCKET_ID = os.getenv("HF_BUCKET_ID", "Angelrider/sonora")
HF_TOKEN = os.getenv("HF_TOKEN", "")

VID_RE = re.compile(r'\[([A-Za-z0-9_-]{11})\]')

def is_target(text: str) -> bool:
    if not text:
        return False
    t = text.lower()
    return "michael jackson" in t or "weeknd" in t

def fetch_bucket_tree(bucket_id: str) -> list:
    url = f"https://huggingface.co/api/buckets/{bucket_id}/tree?recursive=true"
    items = []
    headers = {"User-Agent": "Aura-Pruner/1.0"}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"

    while url:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if not isinstance(data, list):
                break
            items.extend(data)
            link = resp.headers.get("link", "")
            m = re.search(r'<([^>]+)>;\s*rel="next"', link)
            url = m.group(1) if m else None
    return items

def fetch_manifest(bucket_id: str) -> dict:
    url = f"https://huggingface.co/buckets/{bucket_id}/resolve/manifest.json"
    headers = {"User-Agent": "Aura-Pruner/1.0"}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"Warning: could not fetch manifest.json: {e}")
        return {"v": 1, "tracks": {}}

def delete_batch(bucket_id: str, paths: list, token: str) -> dict:
    url = f"https://huggingface.co/api/buckets/{bucket_id}/batch"
    ops = [{"type": "deleteFile", "path": p} for p in paths]
    body = "\n".join(json.dumps(o) for o in ops) + "\n"
    req = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-ndjson",
            "User-Agent": "Aura-Pruner/1.0"
        },
        method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    parser = argparse.ArgumentParser(description="Prune Michael Jackson and The Weeknd from HF bucket")
    parser.add_argument("--dry-run", action="store_true", help="Inspect and report without deleting")
    args = parser.parse_args()

    print(f"Target Bucket: {HF_BUCKET_ID}")
    print(f"Dry Run: {args.dry_run}")

    if not args.dry_run and not HF_TOKEN:
        print("ERROR: HF_TOKEN environment variable is required to execute deletions.", file=sys.stderr)
        sys.exit(1)

    print("Fetching bucket tree...")
    items = fetch_bucket_tree(HF_BUCKET_ID)
    print(f"Total items in bucket: {len(items)}")

    print("Fetching manifest.json...")
    manifest = fetch_manifest(HF_BUCKET_ID)
    tracks = manifest.get("tracks", {})
    print(f"Total tracks in manifest: {len(tracks)}")

    # 1. Identify manifest entries to delete
    manifest_to_delete = {}
    for vid, entry in tracks.items():
        if (is_target(entry.get("a", "")) or
            is_target(entry.get("t", "")) or
            is_target(entry.get("al", ""))):
            manifest_to_delete[vid] = entry

    print(f"Manifest tracks matching Michael Jackson / The Weeknd: {len(manifest_to_delete)}")

    # 2. Identify files in bucket to delete
    files_to_delete = []
    for it in items:
        p = it.get("path", "")
        if p == "manifest.json":
            continue
        # Direct filename match
        if is_target(p):
            files_to_delete.append(it)
            continue
        # Match via video ID in manifest
        m = VID_RE.search(p)
        if m and m.group(1) in manifest_to_delete:
            files_to_delete.append(it)

    total_bytes = sum(f.get("size", 0) for f in files_to_delete)
    print(f"Files to delete: {len(files_to_delete)} ({total_bytes / (1024 * 1024):.2f} MB)")

    if args.dry_run:
        print("\n--- SAMPLE FILES TO DELETE ---")
        for f in files_to_delete[:15]:
            print(f"  {f.get('path')} ({f.get('size', 0)} bytes)")
        if len(files_to_delete) > 15:
            print(f"  ... and {len(files_to_delete) - 15} more")
        print("\nDry run complete. No changes were made.")
        return

    # 3. Perform batch deletion in chunks of 50
    paths_to_delete = [f["path"] for f in files_to_delete]
    chunk_size = 50
    total_chunks = (len(paths_to_delete) + chunk_size - 1) // chunk_size
    print(f"\nDeleting {len(paths_to_delete)} files in {total_chunks} batches...")

    deleted_count = 0
    for i in range(0, len(paths_to_delete), chunk_size):
        chunk = paths_to_delete[i:i + chunk_size]
        batch_num = (i // chunk_size) + 1
        print(f"  Batch {batch_num}/{total_chunks}: deleting {len(chunk)} files...", end=" ", flush=True)
        try:
            res = delete_batch(HF_BUCKET_ID, chunk, HF_TOKEN)
            deleted_count += len(chunk)
            print("OK")
        except Exception as e:
            print(f"FAILED: {e}")
        time.sleep(0.3)

    print(f"Successfully deleted {deleted_count} files.")

    # 4. Prune manifest.json and write updated file
    print("\nUpdating manifest.json...")
    clean_tracks = {vid: ent for vid, ent in tracks.items() if vid not in manifest_to_delete}
    manifest["tracks"] = clean_tracks
    with open("cleaned_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"Cleaned manifest saved (remaining tracks: {len(clean_tracks)}).")

    # 5. Upload cleaned manifest via huggingface_hub CLI or API
    print("Uploading cleaned manifest.json to bucket...")
    upload_success = False

    # Try huggingface_hub Python library first if installed
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=HF_TOKEN)
        api.upload_file(
            path_or_fileobj="cleaned_manifest.json",
            path_in_repo="manifest.json",
            repo_id=HF_BUCKET_ID,
            repo_type="bucket"
        )
        print("Uploaded manifest.json via HfApi.")
        upload_success = True
    except Exception as e:
        print(f"HfApi upload fallback needed: {e}")

    if not upload_success:
        # Try hf buckets cp shell command
        code = os.system(f'hf buckets cp cleaned_manifest.json "hf://buckets/{HF_BUCKET_ID}/manifest.json"')
        if code == 0:
            print("Uploaded manifest.json via hf CLI.")
            upload_success = True
        else:
            print(f"hf CLI returned exit code {code}.")

    # 6. Final verification
    print("\nRunning post-prune verification...")
    post_items = fetch_bucket_tree(HF_BUCKET_ID)
    post_mj_weeknd = [it for it in post_items if is_target(it.get("path", ""))]
    print(f"Total remaining bucket files: {len(post_items)}")
    print(f"Remaining Michael Jackson / The Weeknd files in bucket: {len(post_mj_weeknd)}")

    if len(post_mj_weeknd) == 0:
        print("✓ All Michael Jackson and The Weeknd files successfully purged from Hugging Face bucket!")
    else:
        print(f"⚠️ {len(post_mj_weeknd)} files still matched:")
        for it in post_mj_weeknd:
            print(" ", it.get("path"))

if __name__ == "__main__":
    main()
