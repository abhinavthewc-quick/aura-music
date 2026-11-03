"""Step 1.2: External Metadata & Lyrics Fetching (MusicBrainz / LRCLIB)."""
from __future__ import annotations
import logging
from typing import List, Optional, Dict, Any
import httpx
from telepathy.config import settings

logger = logging.getLogger(__name__)


async def fetch_lrclib_lyrics(
    song_name: str,
    artist: str,
    client: Optional[httpx.AsyncClient] = None
) -> str:
    """Fetch lyrics from LRCLIB API (https://lrclib.net/api/get).

    Returns plain lyrics or synced lyrics as text, or empty string on 404/failure.
    """
    params = {
        "track_name": song_name,
        "artist_name": artist,
    }
    headers = {
        "User-Agent": "AuraMusic/1.0.0 (https://github.com/thegt/aura-music)"
    }

    own_client = client is None
    c = client if client is not None else httpx.AsyncClient(timeout=6.0)

    try:
        resp = await c.get(settings.lrclib_base_url, params=params, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            plain = data.get("plainLyrics") or ""
            synced = data.get("syncedLyrics") or ""
            return plain.strip() or synced.strip()
        elif resp.status_code == 404:
            logger.info(f"LRCLIB: No lyrics found for {artist} - {song_name}")
            return ""
        else:
            logger.warning(f"LRCLIB HTTP {resp.status_code} for {artist} - {song_name}")
            return ""
    except Exception as exc:
        logger.warning(f"LRCLIB lookup failed: {exc}")
        return ""
    finally:
        if own_client:
            await c.aclose()


async def fetch_musicbrainz_metadata(
    song_name: str,
    artist: str,
    client: Optional[httpx.AsyncClient] = None
) -> Dict[str, Any]:
    """Query MusicBrainz for release_year, top_tags (micro-genres), and language.

    Returns dict with keys: 'release_year' (int|None), 'top_tags' (list[str]), 'language' (str).
    """
    url = "https://musicbrainz.org/ws/2/recording/"
    clean_title = song_name.replace('"', '')
    clean_artist = artist.replace('"', '')
    query = f'recording:"{clean_title}" AND artist:"{clean_artist}"'
    params = {
        "query": query,
        "fmt": "json",
        "limit": 3
    }
    headers = {
        "User-Agent": settings.musicbrainz_contact,
        "Accept": "application/json"
    }

    result = {
        "release_year": None,
        "top_tags": [],
        "language": "eng"
    }

    own_client = client is None
    c = client if client is not None else httpx.AsyncClient(timeout=6.0)

    try:
        resp = await c.get(url, params=params, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            recordings = data.get("recordings", [])
            if recordings:
                first = recordings[0]
                # Release year
                first_release = first.get("first-release-date")
                if first_release and len(first_release) >= 4:
                    try:
                        result["release_year"] = int(first_release[:4])
                    except ValueError:
                        pass

                # Tags / micro-genres
                tags = [t.get("name") for t in first.get("tags", []) if t.get("name")]
                if not tags:
                    for rel in first.get("releases", []):
                        for t in rel.get("tags", []):
                            if t.get("name") and t["name"] not in tags:
                                tags.append(t["name"])
                result["top_tags"] = tags[:8]

                # Language
                for rel in first.get("releases", []):
                    lang = rel.get("text-representation", {}).get("language")
                    if lang:
                        result["language"] = lang
                        break
        else:
            logger.info(f"MusicBrainz HTTP {resp.status_code} for query: {query}")
    except Exception as exc:
        logger.warning(f"MusicBrainz lookup failed: {exc}")
    finally:
        if own_client:
            await c.aclose()

    return result
