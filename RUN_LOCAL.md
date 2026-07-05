# Running AGM Sentinel Locally

Exact commands to run the whole project on your machine (Windows). This is the setup we
verified working: **embedded H2** (no Postgres needed), **keyless AI service** (clustering
works without any API key), and the **Angular 22** dev server.

> Shells: commands below are **PowerShell** (your default). Where a Git-Bash form differs,
> it's noted. Run each long-lived service in **its own terminal**.

---

## 0. Prerequisites (already installed on this machine)

| Tool | Version needed | You have |
|---|---|---|
| **Java (JDK)** | 17+ | 17 ✅ |
| **Maven** | 3.9+ | 3.9.10 ✅ |
| **Python** | 3.10+ | 3.10.7 ✅ |
| **Node.js** | **≥ 24.15** (Angular 22 CLI) | 24.18 ✅ |
| **npm** | 10+ | ✅ |

No Docker, no Postgres, no Redis required for local run.

---

## 1. One-time setup

Do this **once**. If you've already done it this session, skip to §2.

### 1a. AI service (Python venv + dependencies)
```powershell
cd f:\UniquePersonalProject\ai-service
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```
*(Git Bash: `./.venv/Scripts/python.exe -m pip install -r requirements.txt`)*

### 1b. Generate the demo annual-report PDF (for grounded draft answers)
```powershell
cd f:\UniquePersonalProject\ai-service
.\.venv\Scripts\python.exe -m pip install reportlab
.\.venv\Scripts\python.exe scripts\generate_report.py
```
This writes `ai-service\knowledge\nimbus-annual-report-2024.pdf`. *(Already generated — only
re-run if you delete it.)*

### 1c. Backend (build the runnable jar)
```powershell
cd f:\UniquePersonalProject\backend
mvn clean package -DskipTests
```
Produces `backend\target\backend-1.0.0.jar`.

### 1d. Frontend (install dependencies)
```powershell
cd f:\UniquePersonalProject\frontend
npm install
```

---

## 2. Run the three services (3 terminals)

Start them **in this order**. Keep each terminal open.

### Terminal 1 — AI service (port 8000)
```powershell
cd f:\UniquePersonalProject\ai-service
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
First start downloads the embedding model (~90 MB) once, then caches it.
Wait until you see `Application startup complete`.

**Verify:**
```powershell
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

### Terminal 2 — Backend (port 8080, H2 in-memory DB)
```powershell
cd f:\UniquePersonalProject\backend
java -jar target\backend-1.0.0.jar --spring.profiles.active=local
```
The `local` profile uses embedded **H2** (no Postgres) and points at the AI service on :8000.

**Verify:**
```powershell
curl http://127.0.0.1:8080/actuator/health
# {"status":"UP"}
```

### Terminal 3 — Frontend (port 4200)
```powershell
cd f:\UniquePersonalProject\frontend
npm start
```
Wait for `Application bundle generation complete`, then open **http://localhost:4200**.

---

## 3. Try it out

1. Open **http://localhost:4200** → **Ask a question** tab.
2. Submit a few paraphrases of the same question, e.g.
   *"When will the dividend be paid?"* and *"What is the dividend payment date?"*
3. The **Moderator board** and **Setup** tabs now require a signed-in moderator (see §3.1).
   Once signed in, the paraphrases collapse into **one cluster** whose count climbs; different
   questions form new topics. The board updates live over WebSocket.

### 3.1 Moderator sign-in & Multi-Factor Authentication (MFA)

Attendees stay anonymous, but moderators log in with a password and (optionally) a second
factor. All factors run locally — no external service.

1. Click **Moderator login** → **New moderator? Register** → create a username + password.
   You're signed straight in (no MFA enrolled yet).
2. Go to the **Security** tab and enroll any of:
   - **PIN** — a 4–8 digit code.
   - **Authenticator (OTP)** — click *Set up authenticator*, scan the QR in Google
     Authenticator / Authy, enter the 6-digit code to enable.
   - **Passkey / biometric** — click *Add passkey*, approve with Windows Hello / fingerprint.
     (Works on `localhost` over HTTP by browser rule.)
3. Click **Logout**, then **Moderator login** again → after the password, it now demands your
   **second factor** (choose PIN, OTP code, or passkey). On success you reach the board.

> Local data is in-memory H2, so accounts reset when the backend restarts.

### 3.2 Passwordless sign-in — Email OTP, Mobile OTP, Google

On the **Moderator login** page, under *"Or sign in with"*:

- **✉️ Email one-time code** — enter an email → *Send code*. In **demo mode** (the default,
  free, no email provider) the 6-digit code is **shown right on the screen** (and logged by the
  backend). Enter it → you're signed in. A user is auto-created for that email.
- **📱 Mobile one-time code** — same flow with a phone number. In demo mode the code is shown on
  screen; configure an SMS provider (see §4.2) to send a **real text** instead.
- **🔵 Sign in with Google** — hidden until you configure Google credentials (see §4.1).

> **Demo mode** is controlled by `otp.demo-mode` (default `true`) — codes are shown on screen so
> everything works free with no provider. Set `OTP_DEMO_MODE=false` + an SMS provider (§4.2) to
> send real texts; email OTP has no wired provider, so it always falls back to demo (code shown).

### 4.1 Enable "Sign in with Google" (optional, free)

1. Go to **https://console.cloud.google.com** → create a project (free, no card).
2. **APIs & Services → OAuth consent screen** → *External* → fill app name + your email → save.
3. **Credentials → Create Credentials → OAuth client ID** → *Web application*.
4. **Authorized redirect URIs** → add `http://localhost:8080/login/oauth2/code/google`
   (for production also add `https://<your-backend>/login/oauth2/code/google`).
5. Copy the **Client ID** and **Client secret**, then restart the backend with them set:
```powershell
cd f:\UniquePersonalProject\backend
$env:SPRING_SECURITY_OAUTH2_CLIENT_REGISTRATION_GOOGLE_CLIENT_ID = "<client-id>"
$env:SPRING_SECURITY_OAUTH2_CLIENT_REGISTRATION_GOOGLE_CLIENT_SECRET = "<secret>"
java -Xmx512m -jar target\backend-1.0.0.jar --spring.profiles.active=local
```
The **Sign in with Google** button now appears. After Google verifies you, the backend issues
a JWT and bounces you back to the app, signed in. With the vars **unset**, Google is simply
hidden and everything else works.

### 4.2 Enable real mobile SMS OTP (optional)

Mobile OTP shows the code on screen in demo mode. To send a **real text**, set an SMS provider.
Two free-ish, no-card options:

**TextBelt** — global, **1 free SMS/day** with the shared key (no signup). Mostly US/Canada; may
not deliver to +91 India numbers.
```powershell
cd f:\UniquePersonalProject\backend
$env:OTP_DEMO_MODE = "false"
$env:OTP_SMS_PROVIDER = "textbelt"
$env:OTP_SMS_API_KEY = "textbelt"
java -Xmx512m -jar target\backend-1.0.0.jar --spring.profiles.active=local
```

**Fast2SMS** — India 🇮🇳, free signup at https://www.fast2sms.com (no card; small top-up via UPI
if you run out of free credits). Get your key from the **Dev API** section.
```powershell
$env:OTP_DEMO_MODE = "false"
$env:OTP_SMS_PROVIDER = "fast2sms"
$env:OTP_SMS_API_KEY = "<your-fast2sms-key>"
java -Xmx512m -jar target\backend-1.0.0.jar --spring.profiles.active=local
```

Register with your **real mobile number**, then use **📱 Mobile one-time code** — the code
arrives as a text and is no longer shown on screen. If sending fails or the provider is unset,
it safely falls back to demo mode. (No SMS gateway offers unlimited real texts to any number for
free without a card — these are the closest.)

### Seed the board with ~25 realistic questions (optional, great for a demo)
With all three services running:
```powershell
cd f:\UniquePersonalProject\ai-service
.\.venv\Scripts\python.exe scripts\seed_questions.py http://127.0.0.1:8080
```
This fires deliberately-overlapping AGM questions so the board fills with ranked, deduplicated
clusters.

### End-to-end check via curl (no browser)
```powershell
# get an anonymous attendee JWT, then submit a question
$tok = (curl -s -X POST http://127.0.0.1:8080/api/auth/attendee -H "Content-Type: application/json" -d '{\"username\":\"a1\"}' | ConvertFrom-Json).token
curl -X POST http://127.0.0.1:8080/api/questions -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -d '{\"text\":\"When is the dividend paid?\",\"attendeeId\":\"a1\",\"weight\":0.3}'
```

---

## 4. Enable AI draft answers (optional — needs a free Groq key)

Clustering, dedup, ranking and the live board **all work with no key**. Only the
**"Draft answer"** button (RAG over the annual report) needs an LLM.

1. Get a **free** key at https://console.groq.com (email login, no credit card).
2. Restart the **AI service** (Terminal 1) with the key set:

```powershell
cd f:\UniquePersonalProject\ai-service
$env:LLM_PROVIDER = "groq"
$env:GROQ_API_KEY = "gsk_your_key_here"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
*(Git Bash: `LLM_PROVIDER=groq GROQ_API_KEY=gsk_... ./.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000`)*

Now **Draft answer** on the moderator board returns a grounded, cited answer from the PDF.

---

## 5. Ports & URLs

| Service | URL |
|---|---|
| Frontend (Angular) | http://localhost:4200 |
| Backend (Spring Boot) | http://localhost:8080 |
| Backend health | http://localhost:8080/actuator/health |
| H2 DB console | http://localhost:8080/h2-console (JDBC URL: `jdbc:h2:mem:sentinel`) |
| AI service (FastAPI) | http://127.0.0.1:8000 |
| AI service docs | http://127.0.0.1:8000/docs |

---

## 6. Stopping

Press **Ctrl+C** in each of the three terminals. Because the DB is in-memory H2, all data is
cleared on backend restart (intentional for local dev).

---

## 7. Troubleshooting (issues we actually hit)

| Symptom | Cause | Fix |
|---|---|---|
| Browser shows only a **dark blue screen** | `sockjs-client` needs a `global` that browsers lack | Already fixed via a shim in `index.html` (`window.global = window`). Hard-refresh `Ctrl+Shift+R`. |
| Angular CLI: *"requires Node ≥24.15"* | Old Node | Use Node 24.18 (installed). `node --version` to confirm. |
| Pylance: *"Import numpy/redis/langchain could not be resolved"* | VS Code using global Python, not the venv | `.vscode\settings.json` pins the venv; or `Ctrl+Shift+P → Python: Select Interpreter → ai-service\.venv`. |
| Editor: *"@angular/forms could not be found"* | Stale Angular Language Service after reinstall | `Ctrl+Shift+P → Developer: Reload Window`. Build is the source of truth (it compiles). |
| Backend fails to connect to DB | Forgot the profile | Must start with `--spring.profiles.active=local` (uses H2). |
| **Draft answer** fails | No LLM key | See §4 — set `GROQ_API_KEY`. Clustering still works without it. |
| Backend can't reach AI service | AI service not started / wrong order | Start Terminal 1 (AI) before Terminal 2 (backend); both must be up. |

---

## Quick reference — copy/paste to start everything

```powershell
# Terminal 1
cd f:\UniquePersonalProject\ai-service; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Terminal 2
cd f:\UniquePersonalProject\backend; java -jar target\backend-1.0.0.jar --spring.profiles.active=local

# Terminal 3
cd f:\UniquePersonalProject\frontend; npm start
```
Then open **http://localhost:4200**.
