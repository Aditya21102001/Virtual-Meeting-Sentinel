"""Seed the running system with realistic VIRTUAL MEETING questions so the moderator board looks alive.

Fires ~45 questions through the Spring Boot backend (full pipeline: auth -> ingest ->
cluster -> board). Many are deliberate paraphrases that should collapse into single clusters,
and they map to facts in the demo annual report so drafts are grounded.

Prereqs: backend + AI service + Postgres running (docker compose up, or run each locally).
Uses only the Python standard library — no extra install needed.

    python scripts/seed_questions.py                       # defaults to http://localhost:8080
    python scripts/seed_questions.py https://your.koyeb.app # seed a deployed backend
"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8080"

# Each inner list is a topic; multiple phrasings should merge into ONE cluster.
# (phrasings, shareholder_weight)
TOPICS = [
    ([
        "When will this year's dividend be paid?",
        "What is the dividend payment date?",
        "On what date do we receive the dividend?",
        "When is the payout for the final dividend?",
        "Dividend credit date please?",
    ], 0.4),
    ([
        "How much did revenue grow this year?",
        "What was the revenue growth rate for FY2024?",
        "By what percentage did total revenue increase?",
        "Tell me about top-line growth this year.",
    ], 0.6),
    ([
        "Is there another share buyback planned?",
        "Will the company do a buyback next year?",
        "Any buyback of shares coming up?",
    ], 0.3),
    ([
        "Were there any changes to the board of directors?",
        "Did any directors join or leave the board?",
        "Who is the new independent director?",
    ], 0.2),
    ([
        "What is the company doing on ESG and sustainability?",
        "What percentage of the workforce are women?",
        "Tell me about your renewable energy and diversity numbers.",
    ], 0.25),
    ([
        "What are the expansion plans for next year?",
        "Which new offices did the company open?",
        "What is the hiring / headcount outlook?",
    ], 0.35),
    # A few singletons that should each form their own cluster.
    (["What was the EBITDA margin this year?"], 0.15),
    (["Is the company debt-free?"], 0.1),
    (["What was the CSR spend and where did it go?"], 0.2),
    (["Did the auditors raise any concerns?"], 0.5),
]


def post(path: str, payload: dict, token: str | None = None) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def main() -> None:
    print(f"Seeding {BASE} ...")
    # One JWT is enough; attendee id varies per question to simulate distinct shareholders.
    token = post("/api/auth/login", {"username": "seed-bot", "role": "ATTENDEE"})["token"]

    n = 0
    for phrasings, weight in TOPICS:
        for i, text in enumerate(phrasings):
            try:
                res = post("/api/questions",
                           {"text": text, "attendeeId": f"seed-{n}", "weight": weight},
                           token)
                n += 1
                tag = "NEW  " if res.get("is_new_cluster") else "merge"
                print(f"[{tag}] size={res.get('cluster_size'):>2}  {text}")
                time.sleep(0.15)   # gentle pacing so the board animates
            except urllib.error.URLError as e:
                print(f"  ! failed ({e}). Is the backend running at {BASE}?")
                return
    print(f"\nDone. Sent {n} questions. Open the moderator board to see the clusters.")


if __name__ == "__main__":
    main()
