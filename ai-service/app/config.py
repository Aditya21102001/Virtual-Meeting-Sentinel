"""Central configuration, loaded from environment variables (see root .env.example)."""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM. "ollama" is the fully self-hosted option: open source, no API key, no account,
    # nothing leaves the machine. "groq"/"gemini" are hosted proprietary services whose free
    # tiers need a key. See app/llm.py.
    llm_provider: str = "groq"            # "ollama" | "groq" | "gemini"
    ollama_model: str = "llama3.2"        # any model pulled locally: `ollama pull llama3.2`
    ollama_base_url: str = "http://localhost:11434"
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"
    # Speech-to-text for meeting recordings (see transcribe.py). Groq hosts Whisper on the same
    # key as the chat model. Configurable because provider model ids are renamed and retired
    # far more often than the code around them changes.
    whisper_model: str = "whisper-large-v3-turbo"
    google_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"

    # Embeddings (local, no API)
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # Data stores
    database_url: str = "postgresql://sentinel:sentinel@localhost:5432/sentinel"
    vector_store: str = "pgvector"        # "pgvector" | "faiss"
    queue_mode: str = "redis"             # "inproc" | "redis" | "kafka"
    redis_url: str = "redis://localhost:6379"

    # Kafka (production-scale ingest + event-sourced cluster rebuild). QUEUE_MODE=kafka.
    kafka_bootstrap_servers: str = "localhost:9092"
    kafka_questions_topic: str = "questions.incoming"

    # Clustering
    cluster_similarity_threshold: float = 0.78

    # Redis stream names
    question_stream: str = "questions:incoming"
    consumer_group: str = "ai-workers"


@lru_cache
def get_settings() -> Settings:
    return Settings()
