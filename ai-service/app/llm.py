"""LLM factory — the whole point of using LangChain here.

The rest of the app never imports a vendor SDK directly. Swap providers by changing
LLM_PROVIDER in .env (ollama -> groq -> gemini -> azure) without touching the RAG code.
This is what makes the resume claim honest: "LLM-agnostic layer, swappable to Azure OpenAI."

Provider notes:
  ollama  fully local and open source (MIT). No API key, no account, no network call
          off the machine, no possibility of a bill. The only option that keeps the whole
          stack self-hosted — everything else here is a hosted service whose free tier is
          a business decision that can change.
  groq    hosted, proprietary service. Generous free tier, needs an API key.
  gemini  hosted, proprietary service. Free tier, needs an API key.

Only the *service* differs — the models served by Ollama (Llama, Mistral, Qwen, Gemma…)
are themselves open-weight.
"""
from functools import lru_cache
from langchain_core.language_models.chat_models import BaseChatModel

from .config import get_settings


@lru_cache
def get_llm() -> BaseChatModel:
    s = get_settings()

    if s.llm_provider == "ollama":
        # langchain-ollama talks HTTP to a local Ollama daemon, so there is no vendor SDK
        # and no credential anywhere in this path.
        from langchain_ollama import ChatOllama
        return ChatOllama(
            model=s.ollama_model, base_url=s.ollama_base_url, temperature=0.2
        )

    if s.llm_provider == "groq":
        from langchain_groq import ChatGroq
        return ChatGroq(model=s.groq_model, api_key=s.groq_api_key, temperature=0.2)

    if s.llm_provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=s.gemini_model, google_api_key=s.google_api_key, temperature=0.2
        )

    # To go to Azure OpenAI later (paid), add:
    #   from langchain_openai import AzureChatOpenAI
    #   return AzureChatOpenAI(azure_deployment=..., api_version=..., ...)
    raise ValueError(
        f"Unknown LLM_PROVIDER: {s.llm_provider!r}. "
        "Expected one of: ollama, groq, gemini."
    )
