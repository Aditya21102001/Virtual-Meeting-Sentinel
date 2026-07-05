"""LLM factory — the whole point of using LangChain here.

The rest of the app never imports a vendor SDK directly. Swap providers by changing
LLM_PROVIDER in .env (groq -> gemini -> azure) without touching the RAG code. This is
what makes the resume claim honest: "LLM-agnostic layer, swappable to Azure OpenAI."
"""
from functools import lru_cache
from langchain_core.language_models.chat_models import BaseChatModel

from .config import get_settings


@lru_cache
def get_llm() -> BaseChatModel:
    s = get_settings()

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
    raise ValueError(f"Unknown LLM_PROVIDER: {s.llm_provider!r}")
