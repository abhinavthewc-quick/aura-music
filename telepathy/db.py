"""Database models and async connection manager."""
from __future__ import annotations
import json
from datetime import datetime, timezone
from typing import List, Optional, Any, Dict
from sqlalchemy import (
    Column, String, Text, Float, BigInteger, Integer, DateTime,
    Index, TypeDecorator, select, delete
)
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import declarative_base
from telepathy.config import settings

Base = declarative_base()


class JSONCompatibleArray(TypeDecorator):
    """Custom type to support ARRAY in PostgreSQL and JSON strings in SQLite."""
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, (list, tuple)):
            return json.dumps(list(value))
        return value

    def process_result_value(self, value, dialect):
        if value is None:
            return []
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except Exception:
                return []
        return []


class TrackEnrichedORM(Base):
    __tablename__ = "tracks_enriched"

    track_id = Column(String(64), primary_key=True)
    song_name = Column(Text, nullable=False)
    artist = Column(Text, nullable=False)
    bpm = Column(Float, nullable=True)
    energy = Column(Float, nullable=True)
    acoustic_warmth = Column(Float, nullable=True)
    onset_density = Column(Float, nullable=True)
    valence = Column(Float, nullable=True)
    arousal = Column(Float, nullable=True)
    nostalgia_index = Column(Float, nullable=True)
    catharsis_score = Column(Float, nullable=True)
    ego_boost = Column(Float, nullable=True)
    focus_compatibility = Column(Float, nullable=True)
    primary_state = Column(String(50), nullable=True, index=True)
    ideal_time_blocks = Column(JSONCompatibleArray, default=list)
    ideal_weather = Column(JSONCompatibleArray, default=list)
    psycho_vector = Column(JSONCompatibleArray, default=list)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class UserTelemetryEventORM(Base):
    __tablename__ = "user_telemetry_events"

    event_id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, index=True)
    track_id = Column(String(64), nullable=False, index=True)
    event_type = Column(String(32), nullable=False)
    completion_ratio = Column(Float, default=0.0)
    time_block = Column(String(32), nullable=False)
    day_type = Column(String(16), nullable=False)
    audio_route = Column(String(32), nullable=False)
    weather = Column(String(32), default="clear")
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)


Index("idx_telemetry_user_time", UserTelemetryEventORM.user_id, UserTelemetryEventORM.created_at.desc())


class Database:
    """Async database helper."""
    def __init__(self, db_url: Optional[str] = None):
        self.url = db_url or settings.database_url
        self.engine = create_async_engine(self.url, echo=False)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    async def init_db(self):
        """Create tables if they don't exist (primarily for SQLite / tests)."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def drop_db(self):
        """Drop tables (for testing)."""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)

    async def close(self):
        """Dispose the engine."""
        await self.engine.dispose()

    def session(self) -> AsyncSession:
        return self.session_factory()


# Global database instance
db = Database()
