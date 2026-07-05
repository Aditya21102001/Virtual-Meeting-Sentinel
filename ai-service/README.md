# AI Service (Python + FastAPI + LangChain)

The intelligence layer: embeds questions, clusters them live, and drafts grounded answers.

## What's inside
| File | Role |
|---|---|
| `app/main.py` | FastAPI endpoints (`/ingest`, `/draft`, `/clusters`, `/health`) |
| `app/embeddings.py` | Local `sentence-transformers` embeddings (no API cost) |
| `app/clustering.py` | **Online nearest-centroid clustering** — the core algorithm |
| `app/rag.py` | LangChain RAG chain over the annual report (FAISS) |
| `app/llm.py` | Provider factory — Groq / Gemini / (later) Azure, one-line swap |
| `app/consumer.py` | Optional Redis Streams worker (production-scale ingest) |
| `db/init.sql` | Postgres + pgvector schema |
| `knowledge/` | Drop the annual-report PDF here |

## Run locally (standalone)
```bash
cd ai-service
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export GROQ_API_KEY=gsk_...        # free key from console.groq.com
uvicorn app.main:app --reload --port 8000
```
Test it:
```bash
curl -X POST localhost:8000/ingest -H "Content-Type: application/json" \
  -d '{"question_id":"1","text":"When will the dividend be paid?","attendee_id":"a1","weight":0.3}'
curl -X POST localhost:8000/ingest -H "Content-Type: application/json" \
  -d '{"question_id":"2","text":"What is the date for dividend payout?","attendee_id":"a2","weight":0.1}'
curl localhost:8000/clusters      # the two near-duplicate questions collapse into ONE cluster
```

## Deploy free on Hugging Face Spaces (no credit card)
1. Create a new **Space** → SDK: **Docker** → name it `agm-sentinel-ai`.
2. Push the contents of this `ai-service/` folder to the Space's git repo
   (HF Spaces builds the `Dockerfile` automatically).
3. In **Settings → Variables and secrets**, add:
   - `GROQ_API_KEY` (secret)
   - `LLM_PROVIDER=groq`
   - `PORT=7860`  ← HF Spaces serves on 7860
4. Wait for the build; your service is at `https://<user>-agm-sentinel-ai.hf.space`.
5. Add an **UptimeRobot** HTTP monitor on `/health` every 10 min to prevent idle sleep.

> Free Spaces sleep when idle and have limited CPU — fine for a portfolio demo. The
> embedding model is baked into the image at build time so cold starts stay quick.
