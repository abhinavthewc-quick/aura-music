#!/usr/bin/env python3
"""Fill in missing audio metadata after a yt-dlp download.

Reads each audio file's embedded tags (via ffprobe), falls back to the
yt-dlp sidecar info.json, and rewrites the file with ffmpeg only when
something is missing. Fields handled: title, artist, date, comment/source.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

AUDIO_EXTS = {".webm", ".m4a", ".mp3", ".opus", ".ogg", ".wav", ".flac", ".aac", ".m4v"}


def ffprobe_format(path: Path) -> dict:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60, check=True,
        )
        data = json.loads(out.stdout or "{}")
    except Exception:
        return {}
    fmt = dict(data.get("format") or {})
    merged = dict(fmt.get("tags") or {})
    for stream in data.get("streams") or []:
        if stream.get("codec_type") == "audio":
            merged.update(stream.get("tags") or {})
    fmt["tags"] = merged
    return fmt


def load_info(path: Path) -> dict:
    info_path = path.parent / (path.name + ".info.json")
    if info_path.exists():
        try:
            return json.loads(info_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def clean_artist(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r"\s*-\s*Topic$", "", name)
    return name.strip()


def artist_from_filename(path: Path) -> str:
    stem = path.stem
    m = re.match(r"^(.+?)\s*-\s*.+\s*\[[\w-]{11}\]$", stem)
    if m:
        return clean_artist(m.group(1))
    return ""


def title_from_filename(path: Path) -> str:
    stem = path.stem
    m = re.match(r"^.+?\s*-\s*(.+?)\s*\[[\w-]{11}\]$", stem)
    if m:
        return m.group(1).strip()
    return stem.strip()


def derive_artist(info: dict, tags: dict, path: Path) -> str:
    for key in ("artist", "album_artist", "performer", "ARTIST", "ALBUM_ARTIST"):
        if tags.get(key):
            return clean_artist(tags[key])
    if info.get("artist"):
        return clean_artist(info["artist"])
    for key in ("channel", "uploader", "creator"):
        if info.get(key):
            cleaned = clean_artist(info[key])
            if cleaned:
                return cleaned
    return artist_from_filename(path)


def derive_title(info: dict, tags: dict, path: Path) -> str:
    for key in ("title", "TITLE"):
        if tags.get(key):
            return tags[key].strip()
    if info.get("title"):
        return info["title"].strip()
    return title_from_filename(path)


def derive_date(info: dict, tags: dict) -> str:
    for key in ("date", "DATE", "year", "YEAR"):
        if tags.get(key):
            return str(tags[key])
    raw = info.get("upload_date") or info.get("release_date") or ""
    m = re.match(r"^(\d{4})(\d{2})(\d{2})$", str(raw))
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""


def derive_comment(info: dict, tags: dict) -> str:
    for key in ("comment", "COMMENT", "description", "DESCRIPTION"):
        if tags.get(key):
            return str(tags[key])
    return info.get("webpage_url") or info.get("original_url") or ""


MUTAGEN_EXTS = {".mp3", ".opus", ".ogg", ".flac", ".m4a", ".mp4", ".m4v"}
M4A_KEYMAP = {
    "title": "\xa9nam", "artist": "\xa9ART", "date": "\xa9day", "comment": "\xa9cmt",
}


def write_with_mutagen(path: Path, fields: dict):
    """Tag edit that preserves embedded cover art. Returns True on success,
    None if mutagen is unavailable/unsupported so the caller can fall back."""
    if path.suffix.lower() not in MUTAGEN_EXTS:
        return None
    try:
        from mutagen import File as MFile
    except Exception:
        return None
    ext = path.suffix.lower()
    try:
        if ext == ".mp3":
            audio = MFile(path, easy=True)
            if audio is None:
                return None

            def set_tag(key, value):
                audio[key] = value
        else:
            audio = MFile(path)
            if audio is None:
                return None
            if audio.tags is None:
                audio.add_tags()
            keymap = M4A_KEYMAP if ext in (".m4a", ".mp4", ".m4v") else None

            def set_tag(key, value):
                audio.tags[keymap.get(key, key) if keymap else key] = value
        for key, value in fields.items():
            set_tag(key, value)
        audio.save()
        return True
    except Exception as exc:
        print(f"  ! mutagen failed for {path.name}: {exc}", file=sys.stderr)
        return None


def write_with_ffmpeg(path: Path, fields: dict) -> bool:
    tmp = path.with_name(path.stem + ".meta-tmp" + path.suffix)
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-map", "0:a", "-c", "copy"]
    for k, v in fields.items():
        cmd += ["-metadata", f"{k}={v}"]
    cmd.append(str(tmp))
    try:
        subprocess.run(cmd, check=True, timeout=120)
        tmp.replace(path)
        return True
    except Exception as exc:
        print(f"  ! ffmpeg failed for {path.name}: {exc}", file=sys.stderr)
        if tmp.exists():
            tmp.unlink()
        return False


def write_metadata(path: Path, fields: dict) -> bool:
    result = write_with_mutagen(path, fields)
    if result is not None:
        return result
    return write_with_ffmpeg(path, fields)


def main(root: str) -> int:
    base = Path(root)
    if not base.is_dir():
        print(f"Directory not found: {root}", file=sys.stderr)
        return 1
    files = sorted(p for p in base.rglob("*") if p.suffix.lower() in AUDIO_EXTS)
    if not files:
        print("No audio files found - nothing to tag.")
        return 0
    fixed = 0
    for f in files:
        info = load_info(f)
        fmt = ffprobe_format(f)
        tags = {str(k).lower(): v for k, v in (fmt.get("tags") or {}).items()}
        need = {}
        title = derive_title(info, tags, f)
        artist = derive_artist(info, tags, f)
        date = derive_date(info, tags)
        comment = derive_comment(info, tags)
        existing_artist = tags.get("artist") or tags.get("performer") or ""
        if not tags.get("title") and title:
            need["title"] = title
        if not existing_artist and artist:
            need["artist"] = artist
        elif existing_artist and existing_artist != artist and existing_artist.endswith("- Topic") and artist:
            need["artist"] = artist
        if not tags.get("date") and date:
            need["date"] = date
        if not tags.get("comment") and not tags.get("description") and comment:
            need["comment"] = comment
        if need:
            label = ", ".join(f"{k}={v}" for k, v in need.items())
            print(f"+ {f.name}: {label}")
            if write_metadata(f, need):
                fixed += 1
        else:
            print(f"= {f.name}: metadata complete")
    print(f"Done. {fixed}/{len(files)} file(s) updated.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "downloads"))
