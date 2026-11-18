"""Tests for Real-time Mind-Read API, Micro-Telemetry Collector, and Cold-Start Protocol."""
import time
from datetime import datetime, timezone, timedelta
import pytest
from httpx import AsyncClient, ASGITransport

from telepathy.api import app
from telepathy.db import db, TrackEnrichedORM, UserTelemetryEventORM
from telepathy.models import EnrichedTrackRecord, MindReadRequest
from telepathy.telepathy_scorer import cold_start_rank_tracks


@pytest.mark.asyncio
async def test_cold_start_protocol_ranking():
    """Verify cold start protocol ranks catalog by matching time block, weather, and audio route."""
    track_commute = EnrichedTrackRecord(
        track_id="trk_c1",
        song_name="Drive Away",
        artist="Cruiser",
        primary_state="commute_cruise",
        ideal_time_blocks=["morning_commute"],
        ideal_weather=["sunny"],
        psycho_vector=[0.7, 0.5, 0.8, 0.6, 0.4, 0.5, 0.7, 0.5]
    )

    track_night = EnrichedTrackRecord(
        track_id="trk_n1",
        song_name="Midnight Dream",
        artist="Moonwalker",
        primary_state="late_night_introspection",
        ideal_time_blocks=["late_night_3am"],
        ideal_weather=["clear_night"],
        psycho_vector=[0.2, 0.8, 0.4, 0.2, 0.9, 0.7, 0.2, 0.8]
    )

    req = MindReadRequest(
        user_id="new_user_99",
        current_time_block="morning_commute",
        day_type="weekday",
        audio_route="car_bluetooth",
        current_weather="sunny"
    )

    ranked = cold_start_rank_tracks([track_commute, track_night], req)
    assert ranked[0][0].track_id == "trk_c1"
    assert ranked[0][1] > ranked[1][1]


@pytest.mark.asyncio
async def test_mind_read_api_end_to_end_and_latency():
    """Test full HTTP API flow: seed catalog, log telemetry, call /mind-read, and verify < 30ms latency."""
    await db.init_db()

    # Seed 3 enriched tracks
    t_now = datetime.now(timezone.utc)
    t1 = TrackEnrichedORM(
        track_id="trk_hero_api",
        song_name="After Dark",
        artist="Mr.Kitty",
        primary_state="melancholic_release",
        ideal_time_blocks=["night_wind_down", "late_night_3am"],
        ideal_weather=["clear_night", "rain"],
        psycho_vector=[0.3, 0.7, 0.3, 0.4, 0.8, 0.7, 0.2, 0.8],
        updated_at=t_now
    )
    t2 = TrackEnrichedORM(
        track_id="trk_twin_api",
        song_name="Goth",
        artist="Sidewalks and Skeletons",
        primary_state="melancholic_release",
        ideal_time_blocks=["night_wind_down", "late_night_3am"],
        ideal_weather=["clear_night"],
        psycho_vector=[0.32, 0.68, 0.31, 0.42, 0.82, 0.71, 0.21, 0.79],
        updated_at=t_now
    )
    t3 = TrackEnrichedORM(
        track_id="trk_pivot_api",
        song_name="Hypest Energy",
        artist="Turbo",
        primary_state="dopamine_hype",
        ideal_time_blocks=["morning_commute", "work_hours"],
        ideal_weather=["sunny"],
        psycho_vector=[0.9, 0.1, 0.9, 0.9, 0.1, 0.4, 0.9, 0.2],
        updated_at=t_now
    )

    async with db.session() as s:
        s.add_all([t1, t2, t3])
        await s.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        # 1. Log subconscious telemetry events (> 5 events to exit cold-start)
        events_payloads = [
            {"user_id": "usr_active", "track_id": "trk_hero_api", "event_type": "SEARCH_AND_PLAY", "time_block": "late_night_3am", "day_type": "weekday", "audio_route": "headphones", "weather": "clear_night"},
            {"user_id": "usr_active", "track_id": "trk_hero_api", "event_type": "VOLUME_SPIKE", "time_block": "late_night_3am", "day_type": "weekday", "audio_route": "headphones", "weather": "clear_night"},
            {"user_id": "usr_active", "track_id": "trk_hero_api", "event_type": "LOOP_ENABLED", "time_block": "late_night_3am", "day_type": "weekday", "audio_route": "headphones", "weather": "clear_night"},
            {"user_id": "usr_active", "track_id": "trk_pivot_api", "event_type": "FULL_LISTEN", "time_block": "late_night_3am", "day_type": "weekday", "audio_route": "headphones", "weather": "clear_night"},
            {"user_id": "usr_active", "track_id": "trk_hero_api", "event_type": "HERO_CARD_PLAY", "time_block": "late_night_3am", "day_type": "weekday", "audio_route": "headphones", "weather": "clear_night"},
            {"user_id": "usr_active", "track_id": "trk_hero_api", "event_type": "FULL_LISTEN", "time_block": "late_night_3am", "day_type": "weekday", "audio_route": "headphones", "weather": "clear_night"},
        ]

        for ep in events_payloads:
            r = await client.post("/api/v1/telemetry/events", json=ep)
            assert r.status_code == 201

        # 2. Call /api/v1/home/mind-read and measure latency
        req_payload = {
            "user_id": "usr_active",
            "current_time_block": "late_night_3am",
            "day_type": "weekday",
            "audio_route": "headphones",
            "current_weather": "clear_night"
        }

        # Warm up request
        await client.post("/api/v1/home/mind-read", json=req_payload)

        # Benchmark request
        start_ts = time.perf_counter()
        resp = await client.post("/api/v1/home/mind-read", json=req_payload)
        latency_ms = (time.perf_counter() - start_ts) * 1000.0

        assert resp.status_code == 200
        data = resp.json()

        # Check Hero Slot #1
        assert "hero_slot_1" in data
        assert data["hero_slot_1"]["track_id"] == "trk_hero_api"
        assert data["hero_slot_1"]["song_name"] == "After Dark"
        assert data["hero_slot_1"]["telepathy_score"] > 0
        assert "prebuffer_audio_bytes_url" in data["hero_slot_1"]
        assert "psychological_ui_badge" in data["hero_slot_1"]

        # Check Orthogonal Pivots
        assert "orthogonal_pivots" in data
        assert len(data["orthogonal_pivots"]) >= 1

        # Check sub-30ms execution requirement
        print(f"\nMind-read endpoint latency: {latency_ms:.2f}ms")
        assert latency_ms < 30.0, f"Expected < 30ms, got {latency_ms:.2f}ms"
