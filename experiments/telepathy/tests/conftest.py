"""Offline test boundary for the quarantined Telepathy prototype.

Set safe configuration before importing the module-level database singleton. A
shell DATABASE_URL or API credential must never turn this suite into an operation
against a real service. The HTTP API tests use httpx.ASGITransport in-process.
"""
import os
import socket

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["LLM_PROVIDER"] = "offline"
os.environ["GEMINI_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["PREBUFFER_BASE_URL"] = "https://example.invalid/test-audio"

import httpx
import pytest_asyncio

from telepathy.db import db
from telepathy import enrichment_worker, external_meta


@pytest_asyncio.fixture(autouse=True)
async def isolated_database_and_providers(monkeypatch):
    """A fresh in-memory database and fixture metadata for every test."""
    if db.url != "sqlite+aiosqlite:///:memory:":
        raise AssertionError("The experiment tests require an in-memory SQLite database")

    outbound_attempts = []

    async def reject_async_http(self, request):
        outbound_attempts.append("http")
        raise AssertionError("External HTTP is disabled in Telepathy tests")

    def reject_http(self, request):
        outbound_attempts.append("http")
        raise AssertionError("External HTTP is disabled in Telepathy tests")

    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def guarded_connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            outbound_attempts.append("socket")
            raise AssertionError("External sockets are disabled in Telepathy tests")
        return original_connect(self, address)

    def guarded_connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            outbound_attempts.append("socket")
            raise AssertionError("External sockets are disabled in Telepathy tests")
        return original_connect_ex(self, address)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", reject_async_http)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", reject_http)
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)

    async def fixture_metadata(song_name, artist, client=None):
        return {"release_year": 2018, "top_tags": ["synth-pop", "ambient"], "language": "eng"}

    async def fixture_lyrics(song_name, artist, client=None):
        return "night light dream dark alone"

    for module in (external_meta, enrichment_worker):
        monkeypatch.setattr(module, "fetch_musicbrainz_metadata", fixture_metadata)
        monkeypatch.setattr(module, "fetch_lrclib_lyrics", fixture_lyrics)

    # The profiler is already pure mathematical code. Exercise it instead of
    # mocking scoring or making a provider call.
    await db.close()
    await db.init_db()
    try:
        yield
    finally:
        await db.close()
        assert not outbound_attempts, "A test attempted external network access"
