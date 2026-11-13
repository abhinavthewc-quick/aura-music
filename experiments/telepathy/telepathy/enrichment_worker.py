"""Phase 1: Metadata Enrichment Pipeline Worker.

Takes (track_id, song_name, artist, audio_path) and generates a deep psycho-acoustic
metadata profile, saving it to tracks_enriched.
"""
from __future__ import annotations
import os
import sys
import asyncio
import argparse
import logging
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Dict, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from telepathy.models import DSPMetrics, PsychoAcousticProfile, EnrichedTrackRecord
from telepathy.dsp import extract_audio_dsp, synthesize_mock_dsp
from telepathy.external_meta import fetch_musicbrainz_metadata, fetch_lrclib_lyrics
from telepathy.llm_profiler import generate_psycho_profile, build_psycho_vector
from telepathy.db import db, TrackEnrichedORM

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("enrichment_worker")


async def enrich_track(
    track_id: str,
    song_name: str,
    artist: str,
    audio_path: Optional[str] = None,
    save_to_db: bool = True,
    session: Optional[AsyncSession] = None
) -> EnrichedTrackRecord:
    """Enrich a track through DSP extraction, external metadata, and LLM profiling.

    Args:
        track_id: Unique identifier for the track.
        song_name: Track title.
        artist: Artist name.
        audio_path: Optional path to local audio file for DSP extraction.
        save_to_db: Whether to upsert into tracks_enriched table.
        session: Optional SQLAlchemy async session.

    Returns:
        EnrichedTrackRecord with complete psycho-acoustic features.
    """
    logger.info(f"Starting enrichment for [{track_id}] '{song_name}' by '{artist}'")

    # Step 1.1: Audio DSP Extraction (Using librosa)
    dsp: DSPMetrics
    if audio_path and os.path.exists(audio_path):
        try:
            logger.info(f"Extracting DSP metrics from audio file: {audio_path}")
            dsp = extract_audio_dsp(audio_path)
        except Exception as exc:
            logger.warning(f"Audio DSP extraction failed for {audio_path}: {exc}. Using deterministic fallback.")
            dsp = synthesize_mock_dsp(f"{track_id}:{song_name}:{artist}")
    else:
        logger.info(f"No audio file available at {audio_path}. Synthesizing deterministic baseline DSP.")
        dsp = synthesize_mock_dsp(f"{track_id}:{song_name}:{artist}")

    # Step 1.2: External Metadata & Lyrics Fetch (MusicBrainz + LRCLIB in parallel)
    meta_task = fetch_musicbrainz_metadata(song_name, artist)
    lyrics_task = fetch_lrclib_lyrics(song_name, artist)

    mb_meta, lyrics = await asyncio.gather(meta_task, lyrics_task, return_exceptions=False)
    top_tags = mb_meta.get("top_tags", [])
    logger.info(f"Fetched external data: {len(top_tags)} tags, lyrics len: {len(lyrics)}")

    # Step 1.3: LLM Psycho-Acoustic Profiling
    profile: PsychoAcousticProfile = await generate_psycho_profile(
        song_name=song_name,
        artist=artist,
        dsp_metrics=dsp,
        top_tags=top_tags,
        lyrics=lyrics
    )

    # Construct the 8-dimensional psycho_vector
    psycho_vector = build_psycho_vector(dsp, profile)

    record = EnrichedTrackRecord(
        track_id=track_id,
        song_name=song_name,
        artist=artist,
        bpm=dsp.bpm,
        energy=dsp.energy,
        acoustic_warmth=dsp.acoustic_warmth,
        onset_density=dsp.onset_density,
        valence=profile.valence,
        arousal=profile.arousal,
        nostalgia_index=profile.nostalgia_index,
        catharsis_score=profile.catharsis_score,
        ego_boost=profile.ego_boost,
        focus_compatibility=profile.focus_compatibility,
        primary_state=profile.primary_psychological_state,
        ideal_time_blocks=profile.ideal_time_blocks,
        ideal_weather=profile.ideal_weather,
        psycho_vector=psycho_vector,
        updated_at=datetime.now(timezone.utc)
    )

    # Save to Database if requested
    if save_to_db:
        await upsert_enriched_track(record, session=session)

    logger.info(f"Completed enrichment for [{track_id}] State: {record.primary_state}, Vector: {record.psycho_vector}")
    return record


async def upsert_enriched_track(record: EnrichedTrackRecord, session: Optional[AsyncSession] = None):
    """Upsert enriched track record into tracks_enriched table."""
    own_session = session is None
    s = session if session is not None else db.session()

    try:
        # Check existing
        result = await s.execute(
            select(TrackEnrichedORM).where(TrackEnrichedORM.track_id == record.track_id)
        )
        existing = result.scalar_one_or_none()

        if existing:
            existing.song_name = record.song_name
            existing.artist = record.artist
            existing.bpm = record.bpm
            existing.energy = record.energy
            existing.acoustic_warmth = record.acoustic_warmth
            existing.onset_density = record.onset_density
            existing.valence = record.valence
            existing.arousal = record.arousal
            existing.nostalgia_index = record.nostalgia_index
            existing.catharsis_score = record.catharsis_score
            existing.ego_boost = record.ego_boost
            existing.focus_compatibility = record.focus_compatibility
            existing.primary_state = record.primary_state
            existing.ideal_time_blocks = record.ideal_time_blocks
            existing.ideal_weather = record.ideal_weather
            existing.psycho_vector = record.psycho_vector
            existing.updated_at = record.updated_at
        else:
            orm_record = TrackEnrichedORM(
                track_id=record.track_id,
                song_name=record.song_name,
                artist=record.artist,
                bpm=record.bpm,
                energy=record.energy,
                acoustic_warmth=record.acoustic_warmth,
                onset_density=record.onset_density,
                valence=record.valence,
                arousal=record.arousal,
                nostalgia_index=record.nostalgia_index,
                catharsis_score=record.catharsis_score,
                ego_boost=record.ego_boost,
                focus_compatibility=record.focus_compatibility,
                primary_state=record.primary_state,
                ideal_time_blocks=record.ideal_time_blocks,
                ideal_weather=record.ideal_weather,
                psycho_vector=record.psycho_vector,
                updated_at=record.updated_at
            )
            s.add(orm_record)

        await s.commit()
    finally:
        if own_session:
            await s.close()


async def backfill_catalog(tracks: List[Dict[str, Any]], concurrency: int = 4):
    """Backfill enrichment for multiple tracks with controlled concurrency."""
    sem = asyncio.Semaphore(concurrency)

    async def worker(item: Dict[str, Any]):
        async with sem:
            return await enrich_track(
                track_id=item["track_id"],
                song_name=item["song_name"],
                artist=item["artist"],
                audio_path=item.get("audio_path"),
                save_to_db=True
            )

    results = await asyncio.gather(*(worker(t) for t in tracks), return_exceptions=True)
    success = sum(1 for r in results if not isinstance(r, Exception))
    logger.info(f"Backfill finished: {success}/{len(tracks)} tracks enriched successfully.")
    return results


def main():
    """CLI entrypoint."""
    parser = argparse.ArgumentParser(description="Enrichment Worker")
    parser.add_argument("--track_id", type=str, help="Unique track ID")
    parser.add_argument("--song_name", type=str, help="Track name")
    parser.add_argument("--artist", type=str, help="Artist name")
    parser.add_argument("--audio_path", type=str, default=None, help="Local path to audio file")
    args = parser.parse_args()

    if not args.track_id or not args.song_name or not args.artist:
        parser.print_help()
        sys.exit(1)

    async def run():
        await db.init_db()
        rec = await enrich_track(
            track_id=args.track_id,
            song_name=args.song_name,
            artist=args.artist,
            audio_path=args.audio_path
        )
        print(rec.model_dump_json(indent=2))

    asyncio.run(run())


if __name__ == "__main__":
    main()
