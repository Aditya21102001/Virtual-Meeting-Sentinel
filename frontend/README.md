# Frontend (Angular)

Two views, both standalone components:
- **Ask a question** (`/ask`) — attendees submit; see whether their question was a new topic or merged.
- **Moderator board** (`/board`) — live, ranked, deduplicated clusters over STOMP WebSocket, with one-click RAG draft answers.

## What's inside
| File | Role |
|---|---|
| `app/services/api.service.ts` | REST calls (auth, submit, board, draft) |
| `app/services/board.service.ts` | STOMP/SockJS live board subscription |
| `app/pages/attendee.component.ts` | question submission view |
| `app/pages/moderator.component.ts` | live moderator board |
| `environments/environment*.ts` | backend URL config |

## Run locally
```bash
cd frontend
npm install
npm start          # http://localhost:4200
```
Point it at your backend by editing `src/environments/environment.ts`
(default `http://localhost:8080`). Open `/ask` in one tab and `/board` in another.

## Deploy free on Vercel (no credit card)
1. Set your backend URL in `src/environments/environment.prod.ts`
   (`apiBase` + `wsUrl` → your Koyeb URL).
2. Push to GitHub → Vercel → **Import Project** → pick the repo, **root directory = `frontend`**.
3. Vercel auto-detects Angular; `vercel.json` handles the SPA rewrites and output dir.
4. Deploy. Your app is live at `https://<project>.vercel.app`.

> Tip: because free backends cold-start, the UI already shows a "server waking up" message
> on the first failed call — that's expected, not a bug.
