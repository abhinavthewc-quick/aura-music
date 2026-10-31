"""Purely Mathematical Psycho-Acoustic Profiling Engine.

Zero AI / LLM dependencies. Uses closed-form psycho-acoustic models:
- Russell's Circumplex Model (Valence-Arousal Space)
- Spectral centroid warmth & acoustic impedance
- Rhythmic entropy and onset density
- Vector quantization distance to canonical psycho-state centroids
"""
from __future__ import annotations
import math
import logging
from typing import List, Optional, Dict, Tuple
import numpy as np
from telepathy.models import DSPMetrics, PsychoAcousticProfile

logger = logging.getLogger(__name__)

# System prompt preserved for schema compliance reference
SYSTEM_PROMPT = """You are a musicologist and behavioral psychologist. Analyze the provided song metadata, DSP acoustic metrics, and lyrics. Output ONLY a valid JSON object matching this exact schema:
{
  'valence': float (0.0 = devastatingly sad/bleak, 1.0 = euphoric/joyful),
  'arousal': float (0.0 = ambient/sleep-inducing, 1.0 = chaotic/adrenaline-pumping),
  'nostalgia_index': float (0.0 to 1.0, likelihood of triggering wistful/nostalgic memory),
  'catharsis_score': float (0.0 to 1.0, emotional release intensity),
  'ego_boost': float (0.0 to 1.0, confidence/power/swagger projection),
  'focus_compatibility': float (0.0 to 1.0, suitability for deep work without lyrical distraction),
  'primary_psychological_state': string (one of: ['late_night_introspection', 'dopamine_hype', 'melancholic_release', 'deep_focus', 'commute_cruise', 'workout_aggression', 'sunday_calm']),
  'ideal_time_blocks': array of strings (subset of: ['early_morning', 'morning_commute', 'work_hours', 'evening_commute', 'night_wind_down', 'late_night_3am']),
  'ideal_weather': array of strings (subset of: ['sunny', 'rain', 'overcast', 'storm', 'clear_night'])
}"""

# 7 Canonical Centroids in 8D Vector Space:
# [energy, acoustic_warmth, valence, arousal, nostalgia_index, catharsis_score, ego_boost, focus_compatibility]
STATE_CENTROIDS: Dict[str, np.ndarray] = {
    'late_night_introspection': np.array([0.25, 0.85, 0.35, 0.25, 0.85, 0.60, 0.20, 0.85]),
    'dopamine_hype':            np.array([0.85, 0.20, 0.85, 0.85, 0.25, 0.70, 0.85, 0.25]),
    'melancholic_release':      np.array([0.30, 0.75, 0.15, 0.35, 0.90, 0.90, 0.20, 0.65]),
    'deep_focus':               np.array([0.25, 0.80, 0.55, 0.25, 0.40, 0.30, 0.25, 0.95]),
    'commute_cruise':           np.array([0.65, 0.45, 0.65, 0.60, 0.50, 0.55, 0.70, 0.55]),
    'workout_aggression':       np.array([0.95, 0.15, 0.50, 0.95, 0.15, 0.85, 0.95, 0.20]),
    'sunday_calm':              np.array([0.25, 0.85, 0.75, 0.20, 0.70, 0.40, 0.30, 0.80]),
}

STATE_TIME_BLOCKS: Dict[str, List[str]] = {
    'late_night_introspection': ['night_wind_down', 'late_night_3am'],
    'dopamine_hype': ['evening_commute', 'morning_commute', 'work_hours'],
    'melancholic_release': ['night_wind_down', 'late_night_3am', 'evening_commute'],
    'deep_focus': ['work_hours', 'early_morning'],
    'commute_cruise': ['morning_commute', 'evening_commute'],
    'workout_aggression': ['morning_commute', 'evening_commute', 'work_hours'],
    'sunday_calm': ['early_morning', 'night_wind_down'],
}

STATE_WEATHER: Dict[str, List[str]] = {
    'late_night_introspection': ['clear_night', 'rain', 'overcast'],
    'dopamine_hype': ['sunny', 'storm'],
    'melancholic_release': ['rain', 'overcast', 'clear_night'],
    'deep_focus': ['rain', 'overcast', 'sunny'],
    'commute_cruise': ['sunny', 'clear_night'],
    'workout_aggression': ['storm', 'sunny'],
    'sunday_calm': ['sunny', 'clear_night', 'overcast'],
}


def compute_lexical_sentiment_offset(lyrics: str) -> float:
    """Pure dictionary-based lexical sentiment offset without AI or network calls."""
    if not lyrics:
        return 0.0
    tokens = lyrics.lower().split()
    if not tokens:
        return 0.0

    # Minimal affective valence dictionary
    pos_words = {
        'love', 'joy', 'happy', 'bright', 'sun', 'shine', 'dance', 'heaven',
        'light', 'good', 'dream', 'smile', 'up', 'sweet', 'fly', 'gold', 'alive'
    }
    neg_words = {
        'dead', 'die', 'dark', 'pain', 'cry', 'tears', 'alone', 'fall',
        'bleed', 'hell', 'hurt', 'lost', 'grave', 'grief', 'cold', 'sorrow', 'sad'
    }

    pos_count = sum(1 for w in tokens if w in pos_words)
    neg_count = sum(1 for w in tokens if w in neg_words)
    total = max(1, pos_count + neg_count)

    return float(np.clip((pos_count - neg_count) / (total * 3.0), -0.20, 0.20))


def compute_mathematical_psycho_vector(
    dsp: DSPMetrics,
    top_tags: Optional[List[str]] = None,
    lyrics: str = "",
    release_year: Optional[int] = None
) -> Tuple[List[float], str]:
    """Pure mathematical psycho-acoustic calculation.

    Returns (8D psycho_vector, primary_state).
    """
    e = float(dsp.energy)
    w = float(dsp.acoustic_warmth)
    bpm = float(dsp.bpm)
    od_norm = float(np.clip(dsp.onset_density / 8.0, 0.0, 1.0))
    lex_offset = compute_lexical_sentiment_offset(lyrics)

    # 1. Valence (0.0 = sad/bleak, 1.0 = euphoric/joyful)
    # Brighter sound (lower warmth) + higher tempo + positive lexical bias
    v_base = 0.45 + (0.35 * ((bpm - 80.0) / 100.0)) + (0.20 * (1.0 - w)) + lex_offset
    valence = float(np.clip(v_base, 0.05, 0.95))

    # 2. Arousal (0.0 = ambient/sleep, 1.0 = adrenaline-pumping)
    # Energy + Tempo + Onset density
    a_base = (0.45 * e) + (0.35 * (bpm / 180.0)) + (0.20 * od_norm)
    arousal = float(np.clip(a_base, 0.05, 0.98))

    # 3. Nostalgia Index (Likelihood of wistful/nostalgic memory)
    # High warmth + lower arousal + release year age
    year_delta = max(0, 2026 - (release_year or 2018))
    year_factor = min(1.0, year_delta / 30.0)
    n_base = (0.45 * w) + (0.35 * (1.0 - arousal)) + (0.20 * year_factor)
    nostalgia = float(np.clip(n_base, 0.05, 0.95))

    # 4. Catharsis Score (Emotional release intensity)
    # High arousal + emotional polarity (|V - 0.5|)
    catharsis = float(np.clip((0.50 * arousal) + (0.50 * abs(valence - 0.5) * 2.0), 0.05, 0.95))

    # 5. Ego Boost (Confidence / power / swagger projection)
    ego = float(np.clip((0.45 * e) + (0.35 * od_norm) + (0.20 * arousal), 0.05, 0.95))

    # 6. Focus Compatibility (Deep work suitability without distraction)
    focus = float(np.clip(
        (0.45 * (1.0 - od_norm)) + (0.35 * w) + (0.20 * (1.0 - abs(e - 0.35))),
        0.05, 0.95
    ))

    # Construct the 8D candidate vector
    vec = [
        round(e, 4),
        round(w, 4),
        round(valence, 4),
        round(arousal, 4),
        round(nostalgia, 4),
        round(catharsis, 4),
        round(ego, 4),
        round(focus, 4)
    ]
    cand_arr = np.array(vec)

    # 7. Mathematical Vector Quantization / Centroid Distance argmin
    best_state = 'commute_cruise'
    min_dist = float('inf')

    for state_name, centroid in STATE_CENTROIDS.items():
        dist = float(np.linalg.norm(cand_arr - centroid))
        if dist < min_dist:
            min_dist = dist
            best_state = state_name

    return vec, best_state


async def generate_psycho_profile(
    song_name: str,
    artist: str,
    dsp_metrics: DSPMetrics,
    top_tags: List[str],
    lyrics: str,
    release_year: Optional[int] = None
) -> PsychoAcousticProfile:
    """Generate psycho-acoustic profile using pure mathematics (zero AI)."""
    vec, state = compute_mathematical_psycho_vector(
        dsp=dsp_metrics,
        top_tags=top_tags,
        lyrics=lyrics,
        release_year=release_year
    )

    blocks = STATE_TIME_BLOCKS.get(state, ['morning_commute', 'evening_commute'])
    weather = STATE_WEATHER.get(state, ['sunny', 'clear_night'])

    return PsychoAcousticProfile(
        valence=vec[2],
        arousal=vec[3],
        nostalgia_index=vec[4],
        catharsis_score=vec[5],
        ego_boost=vec[6],
        focus_compatibility=vec[7],
        primary_psychological_state=state,  # type: ignore[arg-type]
        ideal_time_blocks=blocks,  # type: ignore[arg-type]
        ideal_weather=weather
    )


def build_psycho_vector(dsp: DSPMetrics, profile: PsychoAcousticProfile) -> List[float]:
    """Build the exact 8-dimensional psycho_vector specified in the database schema:

    [energy, acoustic_warmth, valence, arousal, nostalgia_index, catharsis_score, ego_boost, focus_compatibility]
    """
    return [
        float(round(dsp.energy, 4)),
        float(round(dsp.acoustic_warmth, 4)),
        float(round(profile.valence, 4)),
        float(round(profile.arousal, 4)),
        float(round(profile.nostalgia_index, 4)),
        float(round(profile.catharsis_score, 4)),
        float(round(profile.ego_boost, 4)),
        float(round(profile.focus_compatibility, 4))
    ]


def fallback_heuristic_profiler(
    song_name: str,
    artist: str,
    dsp: DSPMetrics,
    top_tags: List[str],
    lyrics: str
) -> PsychoAcousticProfile:
    """Synchronous mathematical profiler."""
    vec, state = compute_mathematical_psycho_vector(dsp, top_tags, lyrics)
    return PsychoAcousticProfile(
        valence=vec[2],
        arousal=vec[3],
        nostalgia_index=vec[4],
        catharsis_score=vec[5],
        ego_boost=vec[6],
        focus_compatibility=vec[7],
        primary_psychological_state=state,  # type: ignore[arg-type]
        ideal_time_blocks=STATE_TIME_BLOCKS.get(state, ['morning_commute', 'evening_commute']),  # type: ignore[arg-type]
        ideal_weather=STATE_WEATHER.get(state, ['sunny', 'clear_night'])
    )
