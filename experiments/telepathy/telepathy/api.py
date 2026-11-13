"""FastAPI Telepathy Service & Micro-Telemetry Collector.

Endpoints:
- POST /api/v1/home/mind-read (< 30ms latency)
- POST /api/v1/telemetry/events (subconscious telemetry logger)
- POST /api/v1/enrichment/track (trigger enrichment pipeline)
"""
from __future__ import annotations
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from telepathy.models import (
    MindReadRequest, MindReadResponse, TelemetryEvent,
    EnrichedTrackRecord
)
from telepathy.db import db, TrackEnrichedORM, UserTelemetryEventORM
from telepathy.telepathy_scorer import (
    score_candidate_tracks, select_orthogonal_slots, cold_start_rank_tracks
)
from telepathy.enrichment_worker import enrich_track

logger = logging.getLogger("telepathy.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB tables on startup
    await db.init_db()
    yield
    await db.close()


app = FastAPI(
    title="Aura Music Psycho-Acoustic & Telepathy Engine",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def get_session() -> AsyncSession:
    async with db.session() as session:
        yield session


def orm_to_track_record(orm: TrackEnrichedORM) -> EnrichedTrackRecord:
    return EnrichedTrackRecord(
        track_id=orm.track_id,
        song_name=orm.song_name,
        artist=orm.artist,
        bpm=orm.bpm,
        energy=orm.energy,
        acoustic_warmth=orm.acoustic_warmth,
        onset_density=orm.onset_density,
        valence=orm.valence,
        arousal=orm.arousal,
        nostalgia_index=orm.nostalgia_index,
        catharsis_score=orm.catharsis_score,
        ego_boost=orm.ego_boost,
        focus_compatibility=orm.focus_compatibility,
        primary_state=orm.primary_state,
        ideal_time_blocks=orm.ideal_time_blocks or [],
        ideal_weather=orm.ideal_weather or [],
        psycho_vector=orm.psycho_vector or [],
        updated_at=orm.updated_at
    )


def orm_to_telemetry_event(orm: UserTelemetryEventORM) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=orm.event_id,
        user_id=orm.user_id,
        track_id=orm.track_id,
        event_type=orm.event_type,  # type: ignore[arg-type]
        completion_ratio=orm.completion_ratio,
        time_block=orm.time_block,  # type: ignore[arg-type]
        day_type=orm.day_type,  # type: ignore[arg-type]
        audio_route=orm.audio_route,  # type: ignore[arg-type]
        weather=orm.weather,
        created_at=orm.created_at
    )


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/api/v1/telemetry/events", status_code=201)
async def log_telemetry_event(
    event: TelemetryEvent,
    session: AsyncSession = Depends(get_session)
):
    """Log subconscious micro-telemetry event from client."""
    orm_event = UserTelemetryEventORM(
        user_id=event.user_id,
        track_id=event.track_id,
        event_type=event.event_type,
        completion_ratio=event.completion_ratio,
        time_block=event.time_block,
        day_type=event.day_type,
        audio_route=event.audio_route,
        weather=event.weather,
        created_at=event.created_at or datetime.now(timezone.utc)
    )
    session.add(orm_event)
    await session.commit()
    return {"status": "logged", "event_type": event.event_type, "track_id": event.track_id}


@app.post("/api/v1/home/mind-read", response_model=MindReadResponse)
async def mind_read(
    req: MindReadRequest,
    session: AsyncSession = Depends(get_session)
):
    """Sub-20ms real-time Slot #1 recommendation endpoint.

    Fetches user's last 30 days of telemetry, scores top candidate tracks,
    and returns Slot #1 Hero alongside 2 Orthogonal Pivots.
    """
    start_time = time.perf_counter()
    t_now = datetime.now(timezone.utc)
    cutoff_30d = t_now - timedelta(days=30)

    # 1. Fetch user's telemetry events in last 30 days
    query = (
        select(UserTelemetryEventORM)
        .where(
            UserTelemetryEventORM.user_id == req.user_id,
            UserTelemetryEventORM.created_at >= cutoff_30d
        )
        .order_by(desc(UserTelemetryEventORM.created_at))
        .limit(300)
    )
    res = await session.execute(query)
    user_events = [orm_to_telemetry_event(r) for r in res.scalars().all()]

    # 2. Check Cold Start (< 5 telemetry events)
    if len(user_events) < 5:
        # Fetch catalog tracks
        catalog_query = select(TrackEnrichedORM).limit(50)
        catalog_res = await session.execute(catalog_query)
        catalog = [orm_to_track_record(r) for r in catalog_res.scalars().all()]
        if not catalog:
            raise HTTPException(status_code=404, detail="No enriched tracks available in catalog")

        ranked_cold = cold_start_rank_tracks(catalog, req)
        cold_tuples = [
            (trk, score, 0.0, 0.0, 0.0, 1.0)
            for trk, score in ranked_cold
        ]
        response = select_orthogonal_slots(
            scored_candidates=cold_tuples,
            all_tracks_catalog=catalog,
            user_telemetry_30d=[],
            request=req,
            t_now=t_now
        )
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        logger.info(f"Mind-read cold start executed in {elapsed_ms:.2f}ms")
        return response

    # 3. Candidate tracks from last 30 days (top 50 candidate tracks)
    candidate_track_ids = list(dict.fromkeys([ev.track_id for ev in user_events]))[:50]

    # Fetch enriched track metadata for candidates
    tracks_query = select(TrackEnrichedORM).where(TrackEnrichedORM.track_id.in_(candidate_track_ids))
    tracks_res = await session.execute(tracks_query)
    candidates = [orm_to_track_record(r) for r in tracks_res.scalars().all()]

    if not candidates:
        # Fallback to catalog if enriched data is missing
        catalog_query = select(TrackEnrichedORM).limit(50)
        catalog_res = await session.execute(catalog_query)
        candidates = [orm_to_track_record(r) for r in catalog_res.scalars().all()]
        if not candidates:
            raise HTTPException(status_code=404, detail="No enriched tracks available")

    # Fetch broader catalog for twin searches
    all_cat_res = await session.execute(select(TrackEnrichedORM).limit(100))
    catalog_pool = [orm_to_track_record(r) for r in all_cat_res.scalars().all()]

    # 4. Score candidate tracks
    scored = score_candidate_tracks(candidates, user_events, req, t_now=t_now)

    # 5. Select Slot 1, Slot 2, Slot 3
    response = select_orthogonal_slots(
        scored_candidates=scored,
        all_tracks_catalog=catalog_pool,
        user_telemetry_30d=user_events,
        request=req,
        t_now=t_now
    )

    elapsed_ms = (time.perf_counter() - start_time) * 1000.0
    logger.info(f"Mind-read scored {len(candidates)} tracks in {elapsed_ms:.2f}ms")
    return response


@app.post("/api/v1/enrichment/track")
async def trigger_track_enrichment(
    track_id: str,
    song_name: str,
    artist: str,
    audio_path: Optional[str] = None,
    background_tasks: BackgroundTasks = None
):
    """Enrich a track asynchronously in background."""
    if background_tasks:
        background_tasks.add_task(enrich_track, track_id, song_name, artist, audio_path, True)
        return {"status": "queued", "track_id": track_id}
    else:
        rec = await enrich_track(track_id, song_name, artist, audio_path, True)
        return {"status": "enriched", "track": rec}
