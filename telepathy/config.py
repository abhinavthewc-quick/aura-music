"""Configuration settings for the Telepathy Engine and Enrichment Pipeline."""
import os
from pydantic import BaseModel, Field


class Settings(BaseModel):
    # Database
    database_url: str = Field(
        default_factory=lambda: os.getenv(
            "DATABASE_URL",
            "sqlite+aiosqlite:///./telepathy.db"
        )
    )

    # LLM Settings
    llm_provider: str = Field(
        default_factory=lambda: os.getenv("LLM_PROVIDER", "gemini").lower()
    )
    gemini_api_key: str = Field(
        default_factory=lambda: os.getenv("GEMINI_API_KEY", "")
    )
    gemini_model: str = Field(
        default_factory=lambda: os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    )
    openai_api_key: str = Field(
        default_factory=lambda: os.getenv("OPENAI_API_KEY", "")
    )
    openai_model: str = Field(
        default_factory=lambda: os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    )

    # External APIs
    musicbrainz_contact: str = Field(
        default_factory=lambda: os.getenv(
            "MUSICBRAINZ_CONTACT",
            "AuraMusicTelepathy/1.0 ( support@auramusic.local )"
        )
    )
    lrclib_base_url: str = "https://lrclib.net/api/get"

    # Prebuffer audio chunk URL template
    prebuffer_base_url: str = Field(
        default_factory=lambda: os.getenv(
            "PREBUFFER_BASE_URL",
            "https://cdn.app.com/chunks"
        )
    )


settings = Settings()
