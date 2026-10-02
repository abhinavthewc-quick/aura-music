#!/usr/bin/env python3
"""Build and refresh the bucket's manifest.json (keyed by video ID).

The site reads it from the public bucket and merges album / year / duration
onto each track (src/core/catalog.ts). Sources in increasing priority:

  1. the manifest already in the bucket   (older runs stay alive)
  2. yt-dlp *.info.json sidecars          (duration, year, raw title)
  3. filenames                            (title/artist, same rules as the site)
  4. the optional META json from the admin panel (cleanest names)

Uploads the merged result with huggingface_hub (bucket API only — new bytes
cannot go through the plain copy/delete batch endpoint).
"""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

AUDIO_EXTS = {".webm", ".m4a", ".mp3", ".opus", ".ogg"}
ID_SUFFIX_RE = re.compile(r"\s\[([\w-]{11})\]$")


def clean_name(name) -> str:
    name = str(name or "").strip()
    name = re.sub(r"\s*-\s*Topic$", "", name)
    return name.strip()


def video_id_of(stem: str):
    m = ID_SUFFIX_RE.search(stem)
    return m.group(1) if m else None


def split_stem(stem: str):
    """'<artist> - <title> [id]' -> (artist, title, id) — mirrors the site."""
    bare = ID_SUFFIX_RE.sub("", stem).strip()
    m = re.match(r"^(.+?)\s+-\s+(.+)$", bare)
    if m:
        return clean_name(m.group(1)), m.group(2).strip(), video_id_of(stem)
    return "", bare, video_id_of(stem)


def load_existing(bucket: str) -> dict:
    try:
        from huggingface_hub import download_bucket_files
        with tempfile.TemporaryDirectory() as td:
            dst = Path(td) / "manifest.json"
            download_bucket_files(bucket, [("manifest.json", str(dst))])
            data = json.loads(dst.read_text(encoding="utf-8"))
        tracks = data.get("tracks")
        if isinstance(tracks, dict):
            return tracks
    except Exception:
        pass  # first run / unreadable — start fresh
    return {}


def seed_from_bucket(bucket: str, tracks: dict) -> int:
    """Give every audio file already in the bucket an entry (t/a from the
    filename) — covers tracks uploaded before manifest.json existed."""
    from huggingface_hub import HfApi
    added = 0
    try:
        items = HfApi().list_bucket_tree(bucket, recursive=True)
    except Exception as exc:
        print(f"! bucket listing failed: {exc}", file=sys.stderr)
        return 0
    for item in items:
        path = str(getattr(item, "path", "") or "")
        p = Path(path)
        if p.suffix.lower() not in AUDIO_EXTS:
            continue
        vid = video_id_of(p.stem)
        if not vid or vid in tracks:
            continue
        artist, title, _ = split_stem(p.stem)
        entry = {"t": title}
        if artist:
            entry["a"] = artist
        tracks[vid] = entry
        added += 1
    return added


def upload_manifest(bucket: str, tracks: dict) -> None:
    from huggingface_hub import batch_bucket_files
    blob = json.dumps({"v": 1, "tracks": tracks}, ensure_ascii=False, indent=1).encode("utf-8")
    batch_bucket_files(bucket, add=[(blob, "manifest.json")])


def parse_meta(raw: str) -> list:
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception as exc:
        print(f"! ignoring unreadable META: {exc}", file=sys.stderr)
        return []
    return [e for e in data if isinstance(e, dict) and e.get("id")]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("downloads", nargs="?", default="downloads")
    ap.add_argument("--bucket", default=os.environ.get("HF_BUCKET_ID", ""))
    ap.add_argument("--meta", default=os.environ.get("META", ""))
    args = ap.parse_args()

    if not args.bucket:
        print("HF_BUCKET_ID is not set", file=sys.stderr)
        return 1

    tracks = load_existing(args.bucket)
    before = len(tracks)
    seeded = seed_from_bucket(args.bucket, tracks)
    added = seeded
    updated = 0

    base = Path(args.downloads)
    for info_path in sorted(base.rglob("*.info.json")) if base.is_dir() else []:
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        audio_stem = info_path.name[: -len(".info.json")]
        artist, title, vid = split_stem(audio_stem)
        vid = vid or (info.get("id") if isinstance(info.get("id"), str) else None)
        if not vid:
            continue
        entry = dict(tracks.get(vid) or {})
        changed = False
        if not entry.get("t"):
            # filename title is the cleaned one; only fall back to the raw
            # video title when the filename had no 'artist - ' structure
            if not artist and isinstance(info.get("title"), str) and info["title"].strip():
                entry["t"] = info["title"].strip()
            else:
                entry["t"] = title
            changed = True
        if not entry.get("a"):
            a = artist or clean_name(info.get("artist") or info.get("channel") or info.get("uploader"))
            if a:
                entry["a"] = a
                changed = True
        dur = info.get("duration")
        if isinstance(dur, (int, float)) and dur > 0:
            d = int(dur)
            if entry.get("d") != d:
                entry["d"] = d
                changed = True
        if not entry.get("y"):
            y = str(info.get("release_year") or "")[:4]
            if not re.match(r"^\d{4}$", y):
                ud = str(info.get("upload_date") or "")
                y = ud[:4] if re.match(r"^\d{8}$", ud) else ""
            if y:
                entry["y"] = y
                changed = True
        if vid not in tracks:
            added += 1
        elif changed:
            updated += 1
        tracks[vid] = entry

    for m in parse_meta(args.meta):
        vid = m.get("id")
        entry = dict(tracks.get(vid) or {})
        changed = False
        for src_key, dst_key in (("title", "t"), ("artist", "a"), ("album", "al")):
            val = clean_name(m.get(src_key)) if src_key != "title" else str(m.get(src_key) or "").strip()
            if val and entry.get(dst_key) != val:
                entry[dst_key] = val
                changed = True
        if vid not in tracks:
            added += 1
        elif changed:
            updated += 1
        tracks[vid] = entry

    try:
        upload_manifest(args.bucket, tracks)
    except Exception as exc:
        print(f"! manifest upload failed: {exc}", file=sys.stderr)
        return 1

    print(
        f"manifest.json: {len(tracks)} entries "
        f"(+{added} new, {updated} updated, was {before})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
