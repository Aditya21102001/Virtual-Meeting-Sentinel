# Backend (Spring Boot)

The enterprise core: auth, question ingest, AI orchestration, and the live moderator board.

## What's inside
| Area | Class |
|---|---|
| Entry | `AgmSentinelApplication` |
| Ingest pipeline | `service/QuestionService` (persist → AI cluster → broadcast) |
| AI client | `service/AiClient` (WebClient → Python service) |
| Live board | `config/WebSocketConfig` (STOMP `/topic/board`) + `BoardRefreshScheduler` |
| REST | `controller/QuestionController`, `ClusterController`, `AuthController` |
| Security | `config/SecurityConfig`, `security/JwtService`, `JwtAuthFilter` |
| Persistence | `model/Question`, `repository/QuestionRepository` |

## API
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | issue a demo JWT (`{username, role}`) |
| POST | `/api/questions` | attendee/mod | submit a question → cluster assignment |
| GET | `/api/clusters` | moderator | current ranked board |
| POST | `/api/clusters/{id}/draft` | moderator | RAG-draft an answer |
| WS | `/ws` → subscribe `/topic/board` | — | live board push |

## Run locally
Needs Postgres + the AI service (use the root `docker compose up`), or run standalone:
```bash
cd backend
export SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/sentinel
export AI_SERVICE_URL=http://localhost:8000
mvn spring-boot:run     # http://localhost:8080
```

## Deploy free on Koyeb (no credit card)
1. Push this repo to GitHub.
2. Koyeb → **Create Web Service** → GitHub → pick the repo, set the **work dir** to `/backend`,
   builder **Dockerfile**.
3. Environment variables:
   - `SPRING_DATASOURCE_URL` = your Neon JDBC URL
     (`jdbc:postgresql://<host>/<db>?sslmode=require`)
   - `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD`
   - `AI_SERVICE_URL` = your HF Space URL (`https://<user>-agm-sentinel-ai.hf.space`)
   - `JWT_SECRET` = a long random string
   - `PORT` = `8080`
4. Expose port `8080`, deploy. Health check path: `/actuator/health`.
5. Add an **UptimeRobot** monitor on `/actuator/health` to avoid idle sleep.

> Render is an equally-free alternative (Web Service → Docker → same env vars).
