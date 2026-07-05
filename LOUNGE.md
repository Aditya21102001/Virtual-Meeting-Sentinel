# Shareholder Lounge — 1‑on‑1 chat + GenAI assistant + real roles

A WhatsApp‑style lounge for **registered members**: a directory of shareholders, real‑time
1‑on‑1 direct messages over an authenticated WebSocket, and a **GenAI assistant** that answers
questions grounded in the company's annual report (reusing the existing RAG knowledge base).
It also makes `ADMIN` / `MODERATOR` / `SHAREHOLDER` real, assignable roles.

This feature is **purely additive** — nothing existing was removed. Public sign‑ups still
default to `MODERATOR`, the anonymous attendee flow is unchanged, and the moderator board keeps
streaming (the new WebSocket auth is lenient — see below).

---

## Architecture

```
 Angular Lounge (/chat) ──── authenticated STOMP (JWT in CONNECT frame) ────┐
   • contact list (online dots, unread, typing…)                            │
   • message thread (bubbles, ✓/✓✓ read ticks)                              ▼
   • ✨ AI Assistant (pinned)                          ┌──────────────────────────────┐
        │  REST (/api/chat/*)                          │  Spring Boot                  │
        └──────────────────────────────────────────────►  • ChatController (REST)      │
                                                        │  • ChatSocketController (WS)  │
   live delivery ◄── /user/queue/messages ─────────────┤  • ChatService  → Postgres    │
   read receipts ◄── /user/queue/read     ─────────────┤  • PresenceService (online)   │
   typing…       ◄── /user/queue/typing   ─────────────┤  • WebSocketAuthInterceptor   │
   presence      ◄── /topic/presence      ─────────────┘         │ AiClient.chat()
                                                                  ▼
                                             Python AI  POST /chat → RAG (FAISS + LLM)
                                                                → grounded answer + citations
```

**Lenient WebSocket auth.** `WebSocketAuthInterceptor` reads the JWT from the STOMP `CONNECT`
frame and sets the session `Principal` when present, but **never rejects** an unauthenticated
connect. This is what keeps the pre‑existing public `/topic/board` (which connects with no auth)
working while giving 1‑on‑1 chat a real identity for `convertAndSendToUser`.

**Sender is server‑derived.** Every message's sender/owner comes from the authenticated
principal — never a request‑body field — so a client cannot spoof another user.

---

## Roles

| Role | Gets | How assigned |
|---|---|---|
| `ADMIN` | everything, incl. role management | promoted in `/members` |
| `MODERATOR` | board, setup, members, Lounge | **default for new sign‑ups** |
| `SHAREHOLDER` | the Lounge (chat + AI) | promoted in `/members` |
| `ATTENDEE` | anonymous question submission | ephemeral token (no user row) |

`ADMIN`/`SHAREHOLDER` were previously unreachable; `UserController` (`/api/users`) + the
`/members` screen now make them assignable. Roles are constants in `security/Roles.java`.

---

## API surface

**REST** (`ChatController`, gated ADMIN/MODERATOR/SHAREHOLDER):
- `GET  /api/chat/contacts` — directory + last message + unread + online.
- `GET  /api/chat/messages/{peer}` — full thread; marks peer→me messages read.
- `POST /api/chat/messages` — `{to, body}` → persist + push to recipient.
- `POST /api/chat/ai` — `{body}` → RAG answer `{answer, citations}` (stored as "AI Assistant").
- `GET  /api/users`, `PATCH /api/users/{id}/role` — member directory + role assignment (MOD/ADMIN).

**WebSocket** (STOMP over SockJS at `/ws`):
- send: `/app/typing` `{to}` — ephemeral "typing…" ping.
- subscribe: `/user/queue/messages`, `/user/queue/read`, `/user/queue/typing`, `/topic/presence`.

**AI service:** `POST /chat` `{message}` → `{answer, citations}` (grounded on the annual report).

---

## Files

- **Backend (new):** `security/Roles.java`, `security/WebSocketAuthInterceptor.java`,
  `model/DirectMessage.java`, `repository/DirectMessageRepository.java`, `service/ChatService.java`,
  `service/PresenceService.java`, `controller/ChatController.java`, `controller/ChatSocketController.java`,
  `controller/UserController.java`, `dto/ChatDtos.java`.
- **Backend (modified):** `config/WebSocketConfig.java` (interceptor + `/queue` + user prefix),
  `config/SecurityConfig.java` (matchers), `service/AiClient.java` (`chat()`).
- **AI service:** `app/rag.py` (`chat()`), `app/schemas.py`, `app/main.py` (`/chat`).
- **Frontend (new):** `services/chat.service.ts`, `pages/chat.component.ts`, `pages/members.component.ts`.
- **Frontend (modified):** `services/auth.guard.ts` (`authGuard`), `services/auth.service.ts`
  (`isShareholder`), `services/api.service.ts` (user methods), `app.routes.ts`, `app.component.ts`
  (nav), `pages/login.component.ts` (role‑based redirect).

---

## Run & verify (localhost)

```bash
cp .env.example .env            # set GROQ_API_KEY (and QUEUE_MODE if using Kafka)
docker compose up --build       # Postgres + AI service + backend  (+ Kafka)
cd frontend && npm install && npm start   # http://localhost:4200
```

1. **Roles:** register two users (both `MODERATOR`). In `/members`, set user **B** to
   `SHAREHOLDER`; re‑login as B → lands on `/chat`.
2. **Real‑time DM:** open two browsers (A and B, both logged in). Message B from A → B's thread
   updates instantly; the online dot shows; **"typing…"** appears while the other types; **✓✓**
   appears once the peer opens the thread.
3. **GenAI:** in the ✨ AI Assistant conversation ask "What was the dividend?" → grounded answer
   with citation links that open the report PDF at the cited page.
4. **Regression:** the moderator board still streams over WS, and anonymous attendees can still
   submit questions at `/ask`.
