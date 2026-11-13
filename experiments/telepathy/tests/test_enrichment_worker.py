"""Tests for Phase 1: Metadata Enrichment Pipeline & Audio DSP."""
import os
import wave
import struct
import math
import tempfile
import pytest

from telepathy.dsp import extract_audio_dsp, synthesize_mock_dsp
from telepathy.models import DSPMetrics, PsychoAcousticProfile
from telepathy.llm_profiler import (
    build_psycho_vector, fallback_heuristic_profiler, SYSTEM_PROMPT
)
from telepathy.enrichment_worker import enrich_track
from telepathy.db import db, TrackEnrichedORM
from sqlalchemy import select


def create_synthetic_wav(filename: str, duration_sec: float = 4.0, sample_rate: int = 22050):
    """Generate a clean synthetic WAV tone with rhythmic pulses for testing DSP extraction."""
    num_samples = int(duration_sec * sample_rate)
    with wave.open(filename, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)

        samples = []
        for i in range(num_samples):
            t = i / sample_rate
            # 440 Hz tone with sharp periodic click every 0.5s (120 bpm)
            tone = math.sin(2 * math.pi * 440 * t)
            # Short burst every 0.5s
            beat_phase = (t % 0.5)
            burst = math.exp(-beat_phase * 30.0)
            val = int(tone * burst * 20000)
            samples.append(struct.pack('<h', max(-32768, min(32767, val))))

        wf.writeframes(b''.join(samples))


def test_audio_dsp_extraction():
    """Verify DSP feature extraction with librosa on synthetic audio."""
    with tempfile.TemporaryDirectory() as td:
        wav_path = os.path.join(td, "test_track.wav")
        create_synthetic_wav(wav_path, duration_sec=3.0)

        dsp = extract_audio_dsp(wav_path)

        assert isinstance(dsp, DSPMetrics)
        assert dsp.bpm >= 0.0
        assert 0.0 <= dsp.energy <= 1.0
        assert 0.0 <= dsp.acoustic_warmth <= 1.0
        assert dsp.onset_density >= 0.0


def test_system_prompt_schema_integrity():
    """Verify exact SYSTEM_PROMPT contains all required schema keys."""
    assert "valence" in SYSTEM_PROMPT
    assert "arousal" in SYSTEM_PROMPT
    assert "nostalgia_index" in SYSTEM_PROMPT
    assert "catharsis_score" in SYSTEM_PROMPT
    assert "ego_boost" in SYSTEM_PROMPT
    assert "focus_compatibility" in SYSTEM_PROMPT
    assert "primary_psychological_state" in SYSTEM_PROMPT
    assert "ideal_time_blocks" in SYSTEM_PROMPT
    assert "ideal_weather" in SYSTEM_PROMPT
    assert "late_night_introspection" in SYSTEM_PROMPT


def test_psycho_vector_dimensions():
    """Verify psycho_vector is exactly an 8-dimensional normalized float array."""
    dsp = DSPMetrics(bpm=120.0, energy=0.75, acoustic_warmth=0.60, onset_density=2.5)
    profile = PsychoAcousticProfile(
        valence=0.8,
        arousal=0.7,
        nostalgia_index=0.5,
        catharsis_score=0.6,
        ego_boost=0.7,
        focus_compatibility=0.4,
        primary_psychological_state="dopamine_hype",
        ideal_time_blocks=["evening_commute"],
        ideal_weather=["sunny"]
    )

    vec = build_psycho_vector(dsp, profile)
    assert len(vec) == 8
    # Exact ordering: [energy, acoustic_warmth, valence, arousal, nostalgia_index, catharsis_score, ego_boost, focus_compatibility]
    assert vec == [0.75, 0.60, 0.8, 0.7, 0.5, 0.6, 0.7, 0.4]


@pytest.mark.asyncio
async def test_enrich_track_end_to_end():
    """Verify full asynchronous enrichment pipeline with database persistence."""
    await db.init_db()

    with tempfile.TemporaryDirectory() as td:
        wav_path = os.path.join(td, "ambient_dark.wav")
        create_synthetic_wav(wav_path, duration_sec=4.0)

        record = await enrich_track(
            track_id="trk_test_101",
            song_name="After Dark",
            artist="Mr.Kitty",
            audio_path=wav_path,
            save_to_db=True
        )

        assert record.track_id == "trk_test_101"
        assert record.song_name == "After Dark"
        assert record.bpm > 0
        assert len(record.psycho_vector) == 8
        assert record.primary_state is not None

        # Verify in DB
        async with db.session() as s:
            result = await s.execute(
                select(TrackEnrichedORM).where(TrackEnrichedORM.track_id == "trk_test_101")
            )
            saved = result.scalar_one_or_none()
            assert saved is not None
            assert saved.track_id == "trk_test_101"
            assert len(saved.psycho_vector) == 8
