"""Unit tests for Phase 3 & Phase 4 Scoring Math, Fatigue Damper, and Orthogonal Fallbacks."""
import math
from datetime import datetime, timezone, timedelta
import pytest

from telepathy.models import (
    TelemetryEvent, EnrichedTrackRecord, MindReadRequest
)
from telepathy.telepathy_scorer import (
    EVENT_WEIGHTS,
    DECAY_LAMBDA,
    compute_obsession_momentum,
    compute_context_match,
    compute_zeigarnik_boost,
    compute_fatigue_damper,
    compute_telepathy_score,
    compute_cosine_similarity,
    generate_psychological_badge,
    score_candidate_tracks,
    cold_start_rank_tracks,
    select_orthogonal_slots,
)


def test_event_weights():
    """Verify exact intent weights specified in section 4.1."""
    assert EVENT_WEIGHTS['SEARCH_AND_PLAY'] == 4.0
    assert EVENT_WEIGHTS['LOOP_ENABLED'] == 3.5
    assert EVENT_WEIGHTS['VOLUME_SPIKE'] == 3.0
    assert EVENT_WEIGHTS['SCRUB_BACK'] == 2.5
    assert EVENT_WEIGHTS['HERO_CARD_PLAY'] == 2.0
    assert EVENT_WEIGHTS['FULL_LISTEN'] == 1.0
    assert EVENT_WEIGHTS['EARLY_SKIP'] == -4.0


def test_obsession_momentum_exponential_decay():
    """Verify exponential time decay: O_i = sum W_k * exp(-0.025 * dt_hours)."""
    t_now = datetime(2026, 10, 31, 20, 0, 0, tzinfo=timezone.utc)

    # Event 1: SEARCH_AND_PLAY right now (dt = 0) -> weight * exp(0) = 4.0
    # Event 2: FULL_LISTEN 27.725887 hours ago -> half life -> 1.0 * 0.5 = 0.5
    half_life_hours = math.log(2) / DECAY_LAMBDA  # ~27.725887
    t_half = t_now - timedelta(hours=half_life_hours)

    # Event 3: 15 days ago -> should be ignored (> 14 days)
    t_old = t_now - timedelta(days=15)

    events = [
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="SEARCH_AND_PLAY",
            time_block="work_hours", day_type="weekday", audio_route="headphones",
            created_at=t_now
        ),
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="FULL_LISTEN",
            time_block="work_hours", day_type="weekday", audio_route="headphones",
            created_at=t_half
        ),
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="SEARCH_AND_PLAY",
            time_block="work_hours", day_type="weekday", audio_route="headphones",
            created_at=t_old
        ),
    ]

    o_i = compute_obsession_momentum(events, t_now)
    # Expected: 4.0 + 0.5 = 4.5
    assert pytest.approx(o_i, 0.001) == 4.5


def test_contextual_sub_persona_match():
    """Verify C_i match score calculation with top-5 averaging and ideal match bonus."""
    track = EnrichedTrackRecord(
        track_id="trk_1",
        song_name="After Dark",
        artist="Mr.Kitty",
        ideal_time_blocks=["night_wind_down", "late_night_3am"],
        ideal_weather=["clear_night", "rain"],
        psycho_vector=[0.5, 0.6, 0.4, 0.5, 0.7, 0.6, 0.3, 0.8]
    )

    t_now = datetime(2026, 10, 31, 23, 0, 0, tzinfo=timezone.utc)

    # 1. Full context match event: time_block (0.40) + audio_route (0.30) + day_type (0.15) + weather (0.15) = 1.00
    ev_full = TelemetryEvent(
        user_id="u1", track_id="trk_1", event_type="FULL_LISTEN",
        time_block="late_night_3am", day_type="weekend", audio_route="headphones",
        weather="clear_night", created_at=t_now
    )

    # 2. Half context match event: time_block (0.40) + weather (0.15) = 0.55
    ev_half = TelemetryEvent(
        user_id="u1", track_id="trk_1", event_type="VOLUME_SPIKE",
        time_block="late_night_3am", day_type="weekday", audio_route="car_bluetooth",
        weather="clear_night", created_at=t_now
    )

    # 3. Negative event: EARLY_SKIP (should be excluded from context match averaging)
    ev_neg = TelemetryEvent(
        user_id="u1", track_id="trk_1", event_type="EARLY_SKIP",
        time_block="late_night_3am", day_type="weekend", audio_route="headphones",
        weather="clear_night", created_at=t_now
    )

    c_i = compute_context_match(
        events_for_track=[ev_full, ev_half, ev_neg],
        track=track,
        current_time_block="late_night_3am",
        current_day_type="weekend",
        current_audio_route="headphones",
        current_weather="clear_night"
    )

    # Avg of positive top matches: (1.00 + 0.55) / 2 = 0.775
    # Bonus for ideal match (late_night_3am in ideal_time_blocks and clear_night in ideal_weather): +0.25
    # Total C_i = 0.775 + 0.25 = 1.025
    assert pytest.approx(c_i, 0.001) == 1.025


def test_zeigarnik_boost():
    """Verify Z_i = 3.5 if track logged INTERRUPTED_MIDWAY in last 8 hours and was NOT skipped."""
    t_now = datetime(2026, 10, 31, 20, 0, 0, tzinfo=timezone.utc)
    t_interrupted = t_now - timedelta(hours=2)

    events = [
        TelemetryEvent(
            user_id="u1", track_id="trk_int", event_type="INTERRUPTED_MIDWAY",
            completion_ratio=0.55, time_block="work_hours", day_type="weekday",
            audio_route="headphones", created_at=t_interrupted
        )
    ]

    z_boost = compute_zeigarnik_boost(events, "trk_int", t_now)
    assert z_boost == 3.5

    # If skipped subsequently, boost must be 0.0
    t_skip = t_now - timedelta(hours=1)
    events_with_skip = [
        TelemetryEvent(
            user_id="u1", track_id="trk_int", event_type="EARLY_SKIP",
            time_block="work_hours", day_type="weekday", audio_route="headphones",
            created_at=t_skip
        ),
        events[0]
    ]
    z_with_skip = compute_zeigarnik_boost(events_with_skip, "trk_int", t_now)
    assert z_with_skip == 0.0

    # If interruption was > 8 hours ago, boost must be 0.0
    t_old = t_now - timedelta(hours=9)
    events_old = [
        TelemetryEvent(
            user_id="u1", track_id="trk_int", event_type="INTERRUPTED_MIDWAY",
            completion_ratio=0.50, time_block="work_hours", day_type="weekday",
            audio_route="headphones", created_at=t_old
        )
    ]
    assert compute_zeigarnik_boost(events_old, "trk_int", t_now) == 0.0


def test_fatigue_damper():
    """Verify F_i:

    - 0.08 if played within last 90 minutes (unless loop enabled)
    - 0.05 if > 18 full plays in last 5 days and last was EARLY_SKIP
    - 1.0 otherwise
    """
    t_now = datetime(2026, 10, 31, 20, 0, 0, tzinfo=timezone.utc)

    # Played 30 mins ago
    t_recent_listen = t_now - timedelta(minutes=30)
    evs_recent = [
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="FULL_LISTEN",
            completion_ratio=1.0, time_block="evening_commute", day_type="weekday",
            audio_route="car_bluetooth", created_at=t_recent_listen
        )
    ]
    assert compute_fatigue_damper(evs_recent, t_now) == 0.08

    # Played 30 mins ago, but LOOP_ENABLED was toggled
    evs_loop = [
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="FULL_LISTEN",
            completion_ratio=1.0, time_block="evening_commute", day_type="weekday",
            audio_route="car_bluetooth", created_at=t_recent_listen
        ),
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="LOOP_ENABLED",
            time_block="evening_commute", day_type="weekday",
            audio_route="car_bluetooth", created_at=t_now - timedelta(minutes=15)
        )
    ]
    assert compute_fatigue_damper(evs_loop, t_now) == 1.0

    # Habituation: 19 full plays in last 5 days, followed by EARLY_SKIP
    evs_habit = []
    for i in range(19):
        evs_habit.append(
            TelemetryEvent(
                user_id="u1", track_id="trk_1", event_type="FULL_LISTEN",
                completion_ratio=0.9, time_block="work_hours", day_type="weekday",
                audio_route="headphones", created_at=t_now - timedelta(days=2, hours=i)
            )
        )
    evs_habit.insert(
        0,
        TelemetryEvent(
            user_id="u1", track_id="trk_1", event_type="EARLY_SKIP",
            completion_ratio=0.05, time_block="work_hours", day_type="weekday",
            audio_route="headphones", created_at=t_now - timedelta(hours=2)
        )
    )
    assert compute_fatigue_damper(evs_habit, t_now) == 0.05


def test_telepathy_score_formula():
    """Verify S_i = ((0.45 * O_i) + (0.35 * C_i * 10) + (0.20 * Z_i)) * F_i."""
    o_i = 10.0
    c_i = 0.8
    z_i = 3.5
    f_i = 1.0

    # Base: (0.45 * 10.0) + (0.35 * 8.0) + (0.20 * 3.5)
    # = 4.5 + 2.8 + 0.7 = 8.0
    score = compute_telepathy_score(o_i, c_i, z_i, f_i)
    assert score == 8.0

    # Dampered by F_i = 0.08
    score_dampered = compute_telepathy_score(o_i, c_i, z_i, 0.08)
    assert pytest.approx(score_dampered, 0.001) == 8.0 * 0.08  # 0.64


def test_psychological_ui_badges():
    """Verify badges matching Section 5 rules."""
    # 1. Z_i > 0
    assert generate_psychological_badge(z_i=3.5, o_i=10.0, audio_route="headphones", current_time_block="work_hours") == "Finish where you left off"

    # 2. O_i > 8.0
    assert generate_psychological_badge(z_i=0.0, o_i=8.5, audio_route="headphones", current_time_block="work_hours") == "Still in your head?"

    # 3. car_bluetooth
    assert generate_psychological_badge(z_i=0.0, o_i=4.0, audio_route="car_bluetooth", current_time_block="morning_commute") == "For the drive"

    # 4. late_night_3am
    assert generate_psychological_badge(z_i=0.0, o_i=4.0, audio_route="headphones", current_time_block="late_night_3am") == "Late night wavelength"

    # 5. Default
    assert generate_psychological_badge(z_i=0.0, o_i=4.0, audio_route="headphones", current_time_block="work_hours") == "Right on cue"


def test_orthogonal_fallbacks_selection():
    """Verify Slot 1 (hero), Slot 2 (twin, sim >= 0.85), Slot 3 (pivot, state!=slot1 & sim < 0.50)."""
    t_now = datetime(2026, 10, 31, 21, 0, 0, tzinfo=timezone.utc)

    # Slot 1 Hero: melancholic_release
    vec_hero = [0.2, 0.7, 0.15, 0.25, 0.9, 0.85, 0.1, 0.7]
    hero = EnrichedTrackRecord(
        track_id="trk_hero", song_name="After Dark", artist="Mr.Kitty",
        primary_state="melancholic_release",
        ideal_time_blocks=["night_wind_down"],
        ideal_weather=["clear_night"],
        psycho_vector=vec_hero
    )

    # Slot 2 Twin: unplayed, high cosine similarity to hero, matching time block
    vec_twin = [0.22, 0.68, 0.16, 0.26, 0.88, 0.84, 0.12, 0.72]
    twin = EnrichedTrackRecord(
        track_id="trk_twin", song_name="Space Song", artist="Beach House",
        primary_state="melancholic_release",
        ideal_time_blocks=["night_wind_down"],
        ideal_weather=["clear_night"],
        psycho_vector=vec_twin
    )
    assert compute_cosine_similarity(vec_hero, vec_twin) >= 0.85

    # Slot 3 Pivot: different primary_state (dopamine_hype) and cosine similarity < 0.50
    vec_pivot = [0.95, 0.1, 0.9, 0.95, 0.1, 0.6, 0.9, 0.1]
    pivot = EnrichedTrackRecord(
        track_id="trk_pivot", song_name="Can't Hold Us", artist="Macklemore",
        primary_state="dopamine_hype",
        ideal_time_blocks=["morning_commute"],
        ideal_weather=["sunny"],
        psycho_vector=vec_pivot
    )
    assert compute_cosine_similarity(vec_hero, vec_pivot) < 0.50

    scored = [
        (hero, 9.5, 9.0, 0.8, 0.0, 1.0),
        (pivot, 7.2, 5.0, 0.7, 0.0, 1.0),
        (twin, 6.0, 4.0, 0.6, 0.0, 1.0),
    ]

    req = MindReadRequest(
        user_id="u1",
        current_time_block="night_wind_down",
        day_type="weekday",
        audio_route="headphones",
        current_weather="clear_night"
    )

    response = select_orthogonal_slots(
        scored_candidates=scored,
        all_tracks_catalog=[hero, twin, pivot],
        user_telemetry_30d=[],
        request=req,
        t_now=t_now
    )

    assert response.hero_slot_1.track_id == "trk_hero"
    assert response.hero_slot_1.telepathy_score == 9.5
    assert len(response.orthogonal_pivots) == 2

    # Slot 2 is twin
    slot2 = next(p for p in response.orthogonal_pivots if p.slot == 2)
    assert slot2.track_id == "trk_twin"
    assert slot2.ui_badge == "Same vibe, fresh track"

    # Slot 3 is pivot
    slot3 = next(p for p in response.orthogonal_pivots if p.slot == 3)
    assert slot3.track_id == "trk_pivot"
    assert slot3.ui_badge == "Switch the energy"
