"""Pytest fixtures for telepathy tests."""
import pytest
from telepathy.db import db, Base


@pytest.fixture(autouse=True)
async def setup_clean_db():
    """Ensure clean database tables for each test."""
    await db.init_db()
    async with db.engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())
    yield
    async with db.engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())
