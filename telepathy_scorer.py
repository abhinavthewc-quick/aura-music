#!/usr/bin/env python3
"""Root entrypoint and module for telepathy_scorer.

Forwards to telepathy.telepathy_scorer.
"""
from telepathy.telepathy_scorer import (
    EVENT_WEIGHTS,
    DECAY_LAMBDA,
    compute_cosine_similarity,
    compute_obsession_momentum,
    compute_context_match,
    compute_zeigarnik_boost,
    compute_fatigue_damper,
    compute_telepathy_score,
    generate_psychological_badge,
    score_candidate_tracks,
    cold_start_rank_tracks,
    select_orthogonal_slots,
)

__all__ = [
    "EVENT_WEIGHTS",
    "DECAY_LAMBDA",
    "compute_cosine_similarity",
    "compute_obsession_momentum",
    "compute_context_match",
    "compute_zeigarnik_boost",
    "compute_fatigue_damper",
    "compute_telepathy_score",
    "generate_psychological_badge",
    "score_candidate_tracks",
    "cold_start_rank_tracks",
    "select_orthogonal_slots",
]
