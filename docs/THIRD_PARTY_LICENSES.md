# Third-party licences

This project is MIT-licensed (see [LICENSE](../LICENSE)). Everything it depends on is
open-source software. Nothing here requires a paid licence, a subscription, or a commercial
agreement to build, run, or self-host.

Audited on 2026-07-31 by reading the licence metadata that ships with the installed packages —
`package.json` for npm, the POM `<licenses>` block for Maven, and package metadata for Python —
rather than from memory. Reproduce it with the commands in [§6](#6-reproducing-this-audit).

---

## 1. Summary

| Component | Packages | Result |
|---|---|---|
| Frontend (npm, incl. transitive + dev) | 836 | **All permissive.** No copyleft, nothing proprietary |
| Backend (Maven) | Spring stack + 6 direct | **All permissive**, except H2 (MPL-2.0/EPL-1.0, weak copyleft) |
| AI service (pip) | ~20 direct | **All permissive**, except psycopg (LGPL-3.0) |
| External tools | FFmpeg | **GPL or LGPL** depending on build — see [§4](#4-ffmpeg-the-one-that-needs-thought) |
| Hosted services | Groq, Gemini | **Proprietary services** — optional, replaceable, see [§5](#5-services-vs-software) |

Two dependencies are copyleft and neither constrains this project:

- **H2** (MPL-2.0 OR EPL-1.0) — a *file-level* copyleft. Obligations attach only to modified H2
  source files. It is used unmodified as a test/dev database driver.
- **psycopg** (LGPL-3.0) — LGPL permits use by any application, under any licence, as long as the
  library itself is not modified and can be replaced. It is a normal `import`, unmodified.

---

## 2. Frontend (npm)

Full dependency tree, production and development:

| Licence | Packages |
|---|---:|
| MIT | 650 |
| ISC | 77 |
| Apache-2.0 | 49 |
| BSD-2-Clause | 22 |
| BlueOak-1.0.0 | 17 |
| BSD-3-Clause | 15 |
| 0BSD | 2 |
| Python-2.0 | 1 (`argparse`) |
| CC-BY-4.0 | 1 (`caniuse-lite`) |
| CC-BY-3.0 | 1 (`spdx-exceptions`) |
| CC0-1.0 | 1 (`spdx-license-ids`) |
| **Total** | **836** |

All permissive. The four Creative-Commons/Python-licensed entries are build-time data tables
(browser support data, SPDX identifier lists), not shipped code.

Direct dependencies:

| Package | Licence | Role |
|---|---|---|
| `@angular/*` | MIT | framework |
| `rxjs` | Apache-2.0 | reactive streams |
| `tslib` | 0BSD | TypeScript runtime helpers |
| `@stomp/stompjs` | Apache-2.0 | STOMP over WebSocket |
| `sockjs-client` | MIT | WebSocket fallback |
| `@simplewebauthn/browser` | MIT | passkey ceremonies |
| **`hls.js`** | **Apache-2.0** | adaptive video playback |
| `typescript` | Apache-2.0 | compiler (dev) |

---

## 3. Backend (Maven) and AI service (pip)

### Backend

| Dependency | Licence |
|---|---|
| Spring Boot / Framework / Security / Kafka | Apache-2.0 |
| Hibernate ORM | Apache-2.0 *(relicensed from LGPL at 5.5 — older references are out of date)* |
| Jackson, Tomcat (embedded), Netty, SLF4J | Apache-2.0 |
| PostgreSQL JDBC driver | BSD-2-Clause |
| **H2 database** | **MPL-2.0 OR EPL-1.0** (dual; weak copyleft, unmodified) |
| JJWT | Apache-2.0 |
| `dev.samstevens.totp` | MIT |
| Yubico `webauthn-server-core` | BSD |
| `com.upokecenter:cbor` | Unlicense (public domain) |
| Bouncy Castle | Bouncy Castle Licence (MIT-style) |

### AI service

| Dependency | Licence |
|---|---|
| FastAPI, pydantic, LangChain (all packages), `langchain-ollama`, `ollama`, faiss-cpu, pgvector, redis | MIT |
| uvicorn, torch, pypdf, numpy | BSD |
| sentence-transformers, transformers, python-multipart | Apache-2.0 |
| **psycopg** | **LGPL-3.0** (unmodified import — see [§1](#1-summary)) |

---

## 4. FFmpeg — the one that needs thought

FFmpeg powers video segmentation. Its licensing is the only genuinely nuanced item here, so it is
worth being precise rather than hand-waving.

**How this project uses it.** FFmpeg is invoked as an **external process** (`ProcessBuilder`, see
`VideoTranscodeService`). No FFmpeg source is copied into this repository, no FFmpeg library is
linked, and no FFmpeg code ships in the built artifacts. Running a program is not creating a
derivative work of it, so **no FFmpeg obligation propagates to this project's own code**, whatever
build you install. This is the same relationship as a script that calls `grep`.

**Which build to install.** Two configurations exist, and it matters if you *redistribute* FFmpeg
binaries alongside the app:

| Build | Licence | Notes |
|---|---|---|
| Default FFmpeg | **LGPL-2.1-or-later** | Fully open source. Lacks libx264 |
| `--enable-gpl` (includes libx264, the usual packaged build) | **GPL-2.0-or-later** | libx264 is GPL; this is what `apt install ffmpeg` and the common Windows builds give you |

Installing either and pointing `FFMPEG_PATH` at it is fine for running this project. If you build a
container image that *bundles* FFmpeg, you are redistributing it and must comply with its licence
(share the corresponding source / offer it) — normally satisfied by installing the distro package
rather than a hand-rolled static binary.

**Fully LGPL alternative.** To avoid GPL components entirely, use an LGPL FFmpeg with OpenH264
(BSD-2-Clause) instead of libx264, and set the encoder accordingly. Or drop H.264 altogether and
encode VP9 or AV1 — both royalty-free — though browser HLS support for them is weaker.

**Codec patents (a separate matter from copyright).** H.264 and AAC are covered by patent pools
(Via LA, formerly MPEG-LA). An open-source *licence* grants copyright permission, not patent
permission. In practice this is not enforced against self-hosted internal deployments and there is
no cost for this project's usage, but it is not the same thing as "royalty-free". If that
distinction matters to you, the royalty-free stack is **AV1 or VP9 video + Opus audio** in a
WebM/CMAF container.

---

## 5. Services vs. software

Every piece of *software* above is open source. Some *hosted services* referenced in the deployment
docs are not, and they are all optional:

| Service | Open source? | Cost | Needed? |
|---|---|---|---|
| **Ollama** (`LLM_PROVIDER=ollama`) | **Yes** (MIT), runs locally | **None** | The self-hosted default for drafting |
| Groq | No — proprietary API | Free tier, needs a key | Optional alternative |
| Google Gemini | No — proprietary API | Free tier, needs a key | Optional alternative |
| Neon / Vercel / Koyeb / HF Spaces / Upstash | Managed hosting | Free tiers | Only for the cloud deployment path |

**To run with zero third-party services and zero cost**, self-host everything:

```bash
LLM_PROVIDER=ollama            # local, open source, no key   → see ai-service/app/llm.py
OLLAMA_MODEL=llama3.2          # after: ollama pull llama3.2
VECTOR_STORE=faiss             # in-process, no external DB
QUEUE_MODE=inproc              # no Redis or Kafka needed
VIDEO_STORAGE_MODE=filesystem  # local disk or a NAS share
```

Postgres, FFmpeg and Ollama are all open source and installable locally. Clustering, dedup, ranking,
the live board, and the whole video library work with **no API key of any kind**; only the "Draft
answer" feature needs an LLM, and Ollama provides that locally.

Embeddings were already local (`sentence-transformers`, Apache-2.0) — they never called an API.

---

## 6. Reproducing this audit

```bash
# Frontend — every package in the tree, grouped by licence
cd frontend && npx license-checker --summary
# (or the dependency-free walk over node_modules/*/package.json used for this report)

# Backend — licences as declared in each POM
mvn -o license:license-list          # requires the license-maven-plugin

# AI service — licences from installed package metadata
ai-service/.venv/Scripts/python -m pip install pip-licenses && pip-licenses --order=license
```

Note that a Maven dependency often declares its licence on its **parent** POM (jjwt → `jjwt-root`,
Netty → `netty-parent`), so reading only the artifact POM shows nothing; the table above follows
those links.
