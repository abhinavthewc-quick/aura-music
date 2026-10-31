#!/usr/bin/env python3
"""Root entrypoint and module for enrichment_worker.

Forwards to telepathy.enrichment_worker.
"""
import sys
from telepathy.enrichment_worker import (
    enrich_track,
    upsert_enriched_track,
    backfill_catalog,
    main
)

if __name__ == "__main__":
    main()
