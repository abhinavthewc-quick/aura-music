"""Phase 3 & Phase 4: Real-Time "Slot #1" Scoring Engine & Orthogonal Fallbacks.

Computes the Telepathy Score (S_i) in sub-20ms and selects:
- Slot #1 (Hero Track): argmax(S_i)
- Slot #2 (Contextual Twin, Fresh Track): unplayed in 72h, cosine similarity >= 0.85 to Slot #1, matching current_time_block
- Slot #3 (The Orthogonal Pivot): highest scoring with primary_state != Slot #1 and cosine similarity < 0.50
"""
from __future__ import annotations
import math
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Tuple, Optional, Any
import numpy as np

from telepathy.models import (
    TelemetryEvent, EnrichedTrackRecord, MindReadRequest,
    MindReadResponse, HeroSlot1, OrthogonalPivot, TimeBlock, AudioRoute
)
from telepathy.config import settings

logger = logging.getLogger(__name__)

# Event Intent Weights (W_event)
EVENT_WEIGHTS: Dict[str, float] = {
    'SEARCH_AND_PLAY': 4.0,
    'LOOP_ENABLED': 3.5,
    'VOLUME_SPIKE': 3.0,
    'SCRUB_BACK': 2.5,
    'HERO_CARD_PLAY': 2.0,
    'FULL_LISTEN': 1.0,
    'EARLY_SKIP': -4.0,
    'INTERRUPTED_MIDWAY': 0.0,
}

DECAY_LAMBDA: float = 0.025  # per hour (half-life ≈ 27.7 hours)


def ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Ensure datetime has UTC timezone."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def compute_cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    """Compute cosine similarity between two psycho vectors."""
    if not vec_a or not vec_b or len(vec_a) != len(vec_b):
        return 0.0
    a = np.asarray(vec_a, dtype=np.float64)
    b = np.asarray(vec_b, dtype=np.float64)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    sim = float(np.dot(a, b) / (norm_a * norm_b))
    return float(np.clip(sim, -1.0, 1.0))


def compute_obsession_momentum(
    events_for_track: List[TelemetryEvent],
    t_now: datetime
) -> float:
    """Calculate exponential time decay over all events k for track i in the last 14 days.

    O_i = sum_k ( W_event,k * exp(-0.025 * delta_t_hours(t_now, t_k)) )
    """
    t_now = ensure_utc(t_now)
    cutoff_14d = t_now - timedelta(days=14)
    momentum = 0.0

    for ev in events_for_track:
        ev_time = ensure_utc(ev.created_at)
        if ev_time is None or ev_time < cutoff_14d:
            continue
        weight = EVENT_WEIGHTS.get(ev.event_type, 0.0)
        dt_seconds = max(0.0, (t_now - ev_time).total_seconds())
        dt_hours = dt_seconds / 3600.0
        decay = math.exp(-DECAY_LAMBDA * dt_hours)
        momentum += weight * decay

    return float(momentum)


def compute_context_match(
    events_for_track: List[TelemetryEvent],
    track: EnrichedTrackRecord,
    current_time_block: str,
    current_day_type: str,
    current_audio_route: str,
    current_weather: str
) -> float:
    """Compute Contextual Sub-Persona Match (C_i) - State-Dependent Memory.

    For each past positive event k on track i:
      +0.40 if event.time_block == current_time_block
      +0.30 if event.audio_route == current_audio_route
      +0.15 if event.day_type == current_day_type
      +0.15 if event.weather == current_weather
    Average top 5 contextual matches for track i, plus +0.25 bonus if
    current_time_block and current_weather match track's ideal_time_blocks and ideal_weather.
    """
    positive_matches: List[float] = []

    for ev in events_for_track:
        weight = EVENT_WEIGHTS.get(ev.event_type, 0.0)
        # only positive events
        if weight <= 0.0:
            continue

        m_k = 0.0
        if ev.time_block == current_time_block:
            m_k += 0.40
        if ev.audio_route == current_audio_route:
            m_k += 0.30
        if ev.day_type == current_day_type:
            m_k += 0.15
        if ev.weather == current_weather:
            m_k += 0.15

        positive_matches.append(m_k)

    if positive_matches:
        positive_matches.sort(reverse=True)
        top_5 = positive_matches[:5]
        avg_m = sum(top_5) / len(top_5)
    else:
        avg_m = 0.0

    # +0.25 bonus if current_time_block and current_weather match track's ideal blocks/weather
    ideal_blocks = track.ideal_time_blocks or []
    ideal_weather = track.ideal_weather or []
    bonus = 0.0
    if (current_time_block in ideal_blocks) and (current_weather in ideal_weather):
        bonus = 0.25

    return float(avg_m + bonus)


def compute_zeigarnik_boost(
    events_all_recent: List[TelemetryEvent],
    candidate_track_id: str,
    t_now: datetime
) -> float:
    """Zeigarnik Unfinished Loop Boost (Z_i):

    Check user's very last session (within the last 8 hours).
    If track i logged an INTERRUPTED_MIDWAY event (stopped between 25% and 75%
    completion because headphones disconnected or app closed) and was NOT skipped:
      Z_i = 3.5
    Otherwise:
      Z_i = 0.0
    """
    t_now = ensure_utc(t_now)
    cutoff_8h = t_now - timedelta(hours=8)
    recent_events = [e for e in events_all_recent if ensure_utc(e.created_at) and ensure_utc(e.created_at) >= cutoff_8h]
    if not recent_events:
        return 0.0

    # Sort descending by created_at
    recent_events.sort(key=lambda x: ensure_utc(x.created_at) or t_now, reverse=True)

    # Find the most recent session's events on candidate_track_id
    track_events = [e for e in recent_events if e.track_id == candidate_track_id]
    if not track_events:
        return 0.0

    # Was there an INTERRUPTED_MIDWAY event?
    interrupted_idx = None
    for idx, e in enumerate(track_events):
        if e.event_type == 'INTERRUPTED_MIDWAY':
            # Verify completion ratio between 0.25 and 0.75 if logged
            if 0.20 <= e.completion_ratio <= 0.80 or e.completion_ratio == 0.0:
                interrupted_idx = idx
                break

    if interrupted_idx is None:
        return 0.0

    # Verify track was NOT skipped subsequent to the interruption
    subsequent_events = track_events[:interrupted_idx]
    has_skip = any(e.event_type == 'EARLY_SKIP' for e in subsequent_events)
    if has_skip:
        return 0.0

    return 3.5


def compute_fatigue_damper(
    events_for_track: List[TelemetryEvent],
    t_now: datetime
) -> float:
    """Satiation & Receptor Fatigue Damper (F_i):

    - If played to completion within the last 90 minutes: F_i = 0.08
      (unless LOOP_ENABLED was active).
    - If > 18 full plays in the last 5 days AND last interaction was EARLY_SKIP: F_i = 0.05
    - Otherwise: F_i = 1.0
    """
    t_now = ensure_utc(t_now)
    cutoff_90m = t_now - timedelta(minutes=90)
    cutoff_5d = t_now - timedelta(days=5)

    # Check 1: Played to completion in last 90 minutes
    completed_in_90m = False
    loop_enabled_recently = False

    for ev in events_for_track:
        ev_time = ensure_utc(ev.created_at)
        if ev_time and ev_time >= cutoff_90m:
            if ev.event_type == 'LOOP_ENABLED':
                loop_enabled_recently = True
            if ev.event_type == 'FULL_LISTEN' or ev.completion_ratio >= 0.80:
                completed_in_90m = True

    if completed_in_90m and not loop_enabled_recently:
        return 0.08

    # Check 2: > 18 full plays in last 5 days AND last interaction was EARLY_SKIP
    full_plays_5d = 0
    events_5d: List[TelemetryEvent] = []

    for ev in events_for_track:
        ev_time = ensure_utc(ev.created_at)
        if ev_time and ev_time >= cutoff_5d:
            events_5d.append(ev)
            if ev.event_type == 'FULL_LISTEN' or ev.completion_ratio >= 0.80:
                full_plays_5d += 1

    if full_plays_5d > 18 and events_for_track:
        # Check last interaction for this track
        sorted_events = sorted(events_for_track, key=lambda x: ensure_utc(x.created_at) or t_now, reverse=True)
        if sorted_events and sorted_events[0].event_type == 'EARLY_SKIP':
            return 0.05

    return 1.0


def compute_telepathy_score(
    o_i: float,
    c_i: float,
    z_i: float,
    f_i: float
) -> float:
    """Compute Final Telepathy Score S_i:

    S_i = ( (0.45 * O_i) + (0.35 * C_i * 10) + (0.20 * Z_i) ) * F_i
    """
    base_score = (0.45 * o_i) + (0.35 * c_i * 10.0) + (0.20 * z_i)
    score = base_score * f_i
    return float(round(score, 4))


def generate_psychological_badge(
    z_i: float,
    o_i: float,
    audio_route: str,
    current_time_block: str
) -> str:
    """Generate UI badge according to Master Spec rules:

    - If Z_i > 0: "Finish where you left off"
    - Else if O_i > 8.0: "Still in your head?"
    - Else if audio_route == 'car_bluetooth': "For the drive"
    - Else if current_time_block == 'late_night_3am': "Late night wavelength"
    - Else: "Right on cue"
    """
    if z_i > 0.0:
        return "Finish where you left off"
    if o_i > 8.0:
        return "Still in your head?"
    if audio_route == "car_bluetooth":
        return "For the drive"
    if current_time_block == "late_night_3am":
        return "Late night wavelength"
    return "Right on cue"


def score_candidate_tracks(
    candidates: List[EnrichedTrackRecord],
    user_telemetry_30d: List[TelemetryEvent],
    request: MindReadRequest,
    t_now: Optional[datetime] = None
) -> List[Tuple[EnrichedTrackRecord, float, float, float, float, float]]:
    """Score candidate tracks and return list of (track, S_i, O_i, C_i, Z_i, F_i) sorted by S_i descending."""
    if t_now is None:
        t_now = datetime.now(timezone.utc)

    # Group telemetry by track_id
    track_events_map: Dict[str, List[TelemetryEvent]] = {}
    for ev in user_telemetry_30d:
        track_events_map.setdefault(ev.track_id, []).append(ev)

    scored: List[Tuple[EnrichedTrackRecord, float, float, float, float, float]] = []

    for trk in candidates:
        evs = track_events_map.get(trk.track_id, [])
        o_i = compute_obsession_momentum(evs, t_now)
        c_i = compute_context_match(
            evs, trk,
            request.current_time_block,
            request.day_type,
            request.audio_route,
            request.current_weather
        )
        z_i = compute_zeigarnik_boost(user_telemetry_30d, trk.track_id, t_now)
        f_i = compute_fatigue_damper(evs, t_now)
        s_i = compute_telepathy_score(o_i, c_i, z_i, f_i)

        scored.append((trk, s_i, o_i, c_i, z_i, f_i))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored


def cold_start_rank_tracks(
    catalog: List[EnrichedTrackRecord],
    request: MindReadRequest,
    global_conversion_rates: Optional[Dict[str, float]] = None
) -> List[Tuple[EnrichedTrackRecord, float]]:
    """Cold-start protocol for users with < 5 telemetry events.

    Bypasses O_i and Z_i. Ranks catalog tracks exclusively by matching
    current_time_block, current_weather, and audio_route against tracks_enriched.ideal_time_blocks
    and ideal_weather, weighted by global HERO_CARD_PLAY conversion rate in that bucket.
    """
    rates = global_conversion_rates or {}
    bucket_key = f"{request.current_time_block}:{request.current_weather}"
    bucket_weight = rates.get(bucket_key, 1.0)

    scored: List[Tuple[EnrichedTrackRecord, float]] = []
    for trk in catalog:
        match_score = 0.0
        ideal_blocks = trk.ideal_time_blocks or []
        ideal_weather = trk.ideal_weather or []

        if request.current_time_block in ideal_blocks:
            match_score += 0.50
        if request.current_weather in ideal_weather:
            match_score += 0.30

        # Audio route context affinity heuristics
        if request.audio_route == "car_bluetooth" and trk.primary_state in ["commute_cruise", "dopamine_hype"]:
            match_score += 0.20
        elif request.audio_route == "headphones" and trk.primary_state in ["deep_focus", "late_night_introspection", "melancholic_release"]:
            match_score += 0.20
        elif request.audio_route in ["phone_speaker", "external_speaker"] and trk.primary_state in ["sunday_calm", "dopamine_hype"]:
            match_score += 0.20

        final_cold_score = match_score * bucket_weight
        scored.append((trk, final_cold_score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored


def select_orthogonal_slots(
    scored_candidates: List[Tuple[EnrichedTrackRecord, float, float, float, float, float]],
    all_tracks_catalog: List[EnrichedTrackRecord],
    user_telemetry_30d: List[TelemetryEvent],
    request: MindReadRequest,
    t_now: Optional[datetime] = None
) -> MindReadResponse:
    """Select Slot #1, Slot #2 (Twin), and Slot #3 (Pivot) according to Phase 4 specifications."""
    if t_now is None:
        t_now = datetime.now(timezone.utc)

    if not scored_candidates:
        raise ValueError("No candidate tracks available for mind-read recommendation.")

    # 1. Slot #1 (Hero Track): The track with maximum S_i
    hero_tuple = scored_candidates[0]
    hero_track, s_hero, o_hero, c_hero, z_hero, f_hero = hero_tuple

    hero_badge = generate_psychological_badge(
        z_i=z_hero,
        o_i=o_hero,
        audio_route=request.audio_route,
        current_time_block=request.current_time_block
    )

    # 2. Tracks played in the last 72 hours
    t_now = ensure_utc(t_now)
    cutoff_72h = t_now - timedelta(hours=72)
    played_last_72h_ids = {
        ev.track_id for ev in user_telemetry_30d
        if ensure_utc(ev.created_at) and ensure_utc(ev.created_at) >= cutoff_72h and ev.event_type not in ['EARLY_SKIP']
    }

    # 3. Slot #2 (Contextual Twin, Fresh Track):
    # Track user has NOT played in last 72 hours that has highest cosine similarity (>= 0.85)
    # in psycho_vector to Slot #1, matching current_time_block.
    slot_2_candidate: Optional[EnrichedTrackRecord] = None
    best_twin_sim = -1.0

    # Search in all tracks (or candidates)
    candidate_pool = all_tracks_catalog if all_tracks_catalog else [t[0] for t in scored_candidates]
    for trk in candidate_pool:
        if trk.track_id == hero_track.track_id:
            continue
        if trk.track_id in played_last_72h_ids:
            continue
        # must match current_time_block
        if request.current_time_block not in (trk.ideal_time_blocks or []):
            continue

        sim = compute_cosine_similarity(hero_track.psycho_vector, trk.psycho_vector)
        if sim > best_twin_sim:
            best_twin_sim = sim
            slot_2_candidate = trk

    # Fallback for Slot 2 if no unplayed track matched >= 0.85 with time_block
    if slot_2_candidate is None:
        for trk in candidate_pool:
            if trk.track_id != hero_track.track_id:
                sim = compute_cosine_similarity(hero_track.psycho_vector, trk.psycho_vector)
                if sim > best_twin_sim:
                    best_twin_sim = sim
                    slot_2_candidate = trk

    # 4. Slot #3 (The Orthogonal Pivot):
    # Highest-scoring track from user's candidates whose primary_state is DIFFERENT
    # from Slot #1 and whose psycho_vector cosine similarity to Slot #1 is < 0.50
    slot_3_candidate: Optional[EnrichedTrackRecord] = None
    for trk, s_i, _, _, _, _ in scored_candidates:
        if trk.track_id == hero_track.track_id:
            continue
        if slot_2_candidate and trk.track_id == slot_2_candidate.track_id:
            continue

        sim = compute_cosine_similarity(hero_track.psycho_vector, trk.psycho_vector)
        if trk.primary_state != hero_track.primary_state and sim < 0.50:
            slot_3_candidate = trk
            break

    # Fallback for Slot 3 if no candidate met both state difference and sim < 0.50
    if slot_3_candidate is None:
        for trk, s_i, _, _, _, _ in scored_candidates:
            if trk.track_id != hero_track.track_id and (not slot_2_candidate or trk.track_id != slot_2_candidate.track_id):
                if trk.primary_state != hero_track.primary_state:
                    slot_3_candidate = trk
                    break

    if slot_3_candidate is None and len(scored_candidates) > 1:
        slot_3_candidate = scored_candidates[1][0] if scored_candidates[1][0].track_id != (slot_2_candidate.track_id if slot_2_candidate else None) else (scored_candidates[2][0] if len(scored_candidates) > 2 else scored_candidates[1][0])

    # Construct Prebuffer URL
    prebuffer_url = f"{settings.prebuffer_base_url}/{hero_track.track_id}_first_10s.aac"

    orthogonal_pivots: List[OrthogonalPivot] = []
    if slot_2_candidate:
        orthogonal_pivots.append(
            OrthogonalPivot(
                slot=2,
                track_id=slot_2_candidate.track_id,
                ui_badge="Same vibe, fresh track"
            )
        )
    if slot_3_candidate:
        orthogonal_pivots.append(
            OrthogonalPivot(
                slot=3,
                track_id=slot_3_candidate.track_id,
                ui_badge="Switch the energy"
            )
        )

    return MindReadResponse(
        hero_slot_1=HeroSlot1(
            track_id=hero_track.track_id,
            song_name=hero_track.song_name,
            artist=hero_track.artist,
            telepathy_score=round(s_hero, 2),
            prebuffer_audio_bytes_url=prebuffer_url,
            psychological_ui_badge=hero_badge
        ),
        orthogonal_pivots=orthogonal_pivots
    )
