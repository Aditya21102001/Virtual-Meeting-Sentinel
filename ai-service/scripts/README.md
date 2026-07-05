# Demo scripts

Two helpers to make the project demo-ready for recruiters.

## 1. `generate_report.py` — mock annual report
Creates `knowledge/nimbus-annual-report-2024.pdf`, a realistic report whose facts
(dividend ₹4.50, revenue +18.3%, buyback, board changes, ESG, expansion) match the seeded
questions — so the RAG draft answers are grounded and citable.

```bash
cd ai-service
./.venv/Scripts/python.exe scripts/generate_report.py     # Windows venv
# or:  python scripts/generate_report.py
```
Already generated once; re-run only if you change the content.
(Needs `reportlab`: `pip install reportlab` — a dev-only dep, not required at runtime.)

## 2. `seed_questions.py` — populate the live board
Fires ~45 AGM questions through the backend. Many are paraphrases that collapse into single
clusters (semantic dedup in action); a few are singletons. Weights simulate different
shareholder sizes so the ranking is interesting.

```bash
# Backend + AI service + Postgres must be running first (docker compose up).
python scripts/seed_questions.py                        # local  (http://localhost:8080)
python scripts/seed_questions.py https://your.koyeb.app # a deployed backend
```

**Demo flow:** open the moderator board (`/board`), run the seed script, and watch clusters
appear and grow in real time. Then click **Draft answer** on the dividend cluster — the RAG
chain answers "…paid on or before 5 September 2024" with a citation to the report.
