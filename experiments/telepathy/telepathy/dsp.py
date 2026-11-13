"""Step 1.1: Audio DSP Extraction using librosa."""
from __future__ import annotations
import os
import logging
from typing import Optional, Tuple
import numpy as np
from telepathy.models import DSPMetrics

logger = logging.getLogger(__name__)


def extract_audio_dsp(
    audio_path: str,
    sr: int = 22050,
    max_duration_sec: float = 90.0,
    catalog_min_rms: float = 0.01,
    catalog_max_rms: float = 0.35
) -> DSPMetrics:
    """Extract normalized DSP features (bpm, energy, acoustic_warmth, onset_density) from an audio file.

    Features:
      - bpm: Tempo via librosa.beat.beat_track
      - energy: Mean RMS normalized against catalog min/max [0.0, 1.0]
      - acoustic_warmth: 1.0 - normalized spectral centroid [0.0, 1.0]
      - onset_density: Average number of rhythmic onsets per second
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    import librosa

    # Load up to max_duration_sec mono audio at target sample rate
    y, sample_rate = librosa.load(audio_path, sr=sr, mono=True, duration=max_duration_sec)
    duration = float(librosa.get_duration(y=y, sr=sample_rate))
    if duration <= 0.0 or len(y) == 0:
        raise ValueError(f"Empty or unreadable audio content in {audio_path}")

    # 1. BPM / Tempo
    tempo, _ = librosa.beat.beat_track(y=y, sr=sample_rate)
    if isinstance(tempo, np.ndarray):
        bpm = float(tempo.item(0)) if tempo.size > 0 else 120.0
    else:
        bpm = float(tempo)
    bpm = round(float(bpm) if bpm > 0.0 else 120.0, 2)

    # 2. RMS Energy
    rms_frames = librosa.feature.rms(y=y)
    mean_rms = float(np.mean(rms_frames))
    if catalog_max_rms > catalog_min_rms:
        normalized_energy = (mean_rms - catalog_min_rms) / (catalog_max_rms - catalog_min_rms)
    else:
        normalized_energy = mean_rms / 0.35
    energy = float(np.clip(normalized_energy, 0.0, 1.0))

    # 3. Acoustic Warmth (Inverse of normalized spectral centroid)
    # Higher warmth = darker/warmer; lower warmth = brighter/sharper
    spec_centroid = librosa.feature.rms if False else librosa.feature.spectral_centroid(y=y, sr=sample_rate)
    mean_centroid = float(np.mean(spec_centroid))
    # Typical music spectral centroid ranges from 500Hz (warm) to 4500Hz+ (bright)
    # Normalizing with 5000 Hz ceiling
    norm_centroid = float(np.clip(mean_centroid / 5000.0, 0.0, 1.0))
    acoustic_warmth = float(np.clip(1.0 - norm_centroid, 0.0, 1.0))

    # 4. Onset Density (Average rhythmic onsets per second)
    onsets = librosa.onset.onset_detect(y=y, sr=sample_rate)
    onset_count = len(onsets)
    onset_density = float(onset_count / max(1.0, duration))

    return DSPMetrics(
        bpm=bpm,
        energy=round(energy, 4),
        acoustic_warmth=round(acoustic_warmth, 4),
        onset_density=round(onset_density, 4)
    )


def synthesize_mock_dsp(
    seed_str: str = ""
) -> DSPMetrics:
    """Generate deterministic, realistic DSP metrics for tests or missing audio files."""
    import hashlib
    h = int(hashlib.md5(seed_str.encode()).hexdigest(), 16)
    bpm = 80.0 + (h % 80)
    energy = round(0.2 + ((h >> 8) % 70) / 100.0, 4)
    warmth = round(0.1 + ((h >> 16) % 80) / 100.0, 4)
    onset_density = round(1.0 + ((h >> 24) % 40) / 10.0, 4)
    return DSPMetrics(
        bpm=bpm,
        energy=min(1.0, energy),
        acoustic_warmth=min(1.0, warmth),
        onset_density=onset_density
    )
