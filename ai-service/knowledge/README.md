# Knowledge base

Drop the company's **annual report PDF(s)** in this folder (e.g. `annual-report-2024.pdf`).

On startup the AI service:
1. reads every `*.pdf` here,
2. splits each page into ~1000-char chunks,
3. embeds them locally with `all-MiniLM-L6-v2`,
4. builds a FAISS index used by the RAG draft chain.

No PDF? The service still boots with an empty knowledge base and will say it can't find
the answer in the report (safe fallback). For a demo, any public company's annual report
PDF works great.
