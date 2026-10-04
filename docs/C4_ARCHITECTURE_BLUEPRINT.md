# Virtual Meeting Sentinel — Comprehensive C4 Architectural Blueprint

> **System Scope**: Real-time crowd-question intelligence, semantic deduplication, grounded RAG answering, secure voting governance, and adaptive HLS video streaming for Annual General Meetings (AGM) and large-scale corporate assemblies.

---

## 1. Executive Summary & Design Principles

During an Annual General Meeting with up to 10,000+ live participants, hundreds of questions arrive per minute. 60–70% are semantically duplicate inquiries ("What about the dividend?", "Will dividends increase this year?", "Payout ratio update?"). Human chairs and moderators cannot triage this flood manually without delaying meeting proceedings.

**Virtual Meeting Sentinel** provides:
1. **Instant Semantic Clustering & Deduplication**: Groups identical intents via incremental nearest-centroid clustering in vector space (cosine similarity $\ge 0.78$) rather than naive keyword matching.
2. **Deterministic & Grounded RAG Answering**: Answers top clusters using FAISS vector retrieval strictly confined to uploaded annual reports and regulatory filings, citing exact documents and pages without hallucination.
3. **Automated Background Drafting**: As soon as a question or cluster arrives, background workers (`ClusterDraftWorker`) trigger drafting off the request thread, ensuring moderators see pre-grounded answers immediately.
4. **Resilient Dual Ingestion Pipeline**: Supports both low-latency synchronous HTTP and event-sourced Apache Kafka streaming (`questions.incoming`), resilient against downstream AI hiccups.
5. **Legally Compliant Two-Phase Voting**: Enforces role boundaries, verified shareholder equity weighting, and secret balloting.
6. **Adaptive HLS Video Distribution with Persistent PiP**: Multi-rendition video transcode with DOM-anchored Picture-in-Picture that survives page transitions without exiting.

---

## 2. C4 Level 1 — System Context

The System Context diagram details how Virtual Meeting Sentinel interacts with human roles and third-party external services.

```mermaid
C4Context
    title System Context Diagram — Virtual Meeting Sentinel

    Person(attendee, "Attendee / Shareholder", "Submits questions, casts weighted votes on resolutions, watches live meeting and video archive.")
    Person(moderator, "Moderator / Chair", "Reviews real-time clustered questions, curates/merges topics, reviews grounded LLM answers, publishes answers to the room, opens ballots.")
    Person(admin, "System Administrator", "Uploads regulatory documents/PDFs, manages recordings, configures meeting scopes, audits system logs.")

    System(sentinel, "Virtual Meeting Sentinel", "Clusters live questions, auto-drafts cited answers via RAG, streams live board, manages ballots, and streams HLS recordings.")

    System_Ext(google_auth, "Google Identity Services", "OAuth 2.0 / OpenID Connect authentication provider.")
    System_Ext(brevo, "Brevo (Sendinblue)", "Transactional email and SMS gateway for OTP and MFA challenges.")
    System_Ext(llm_gateway, "LLM Inference Provider", "Groq (Llama-3.3-70b) / Google Gemini / Azure OpenAI for grounded RAG drafting.")
    System_Ext(storage_nas, "NAS / Shared Storage", "Stores source annual report PDFs, raw MP4 recordings, HLS segments (.ts), and seek filmstrips.")

    Rel(attendee, sentinel, "Asks questions, casts votes, watches stream", "HTTPS / WSS")
    Rel(moderator, sentinel, "Triages clusters, publishes answers, conducts voting", "HTTPS / WSS")
    Rel(admin, sentinel, "Uploads reports, monitors system health", "HTTPS")

    Rel(sentinel, google_auth, "Validates OAuth tokens", "HTTPS / REST")
    Rel(sentinel, brevo, "Dispatches OTP / MFA codes", "HTTPS / REST")
    Rel(sentinel, llm_gateway, "Drafts answers against report context", "HTTPS / REST")
    Rel(sentinel, storage_nas, "Reads/writes video segments and PDF reports", "POSIX / SMB")
```

---

## 3. C4 Level 2 — Container Architecture

The Container diagram illustrates the high-level technology choices, container boundaries, and inter-service communication protocols.

```mermaid
C4Container
    title Container Diagram — Virtual Meeting Sentinel

    Person(user, "User (Attendee / Moderator / Admin)", "Accesses the platform via modern web browser")

    Container(spa, "Single Page Application (SPA)", "Angular 19+, TypeScript, Signals, Tailwind/CSS, HLS.js, StompJS", "Provides real-time UI, live board updates, reactive voting, and PiP-preserved video playback.")

    Container(api, "Core Backend Gateway & Engine", "Java 17/21, Spring Boot 3.x, Spring Security, Spring Data JPA, Spring WebSocket", "Handles authentication, RBAC/MFA, meeting scopes, durable storage, WebSocket STOMP broadcasting, voting transactions, and video transcode orchestration.")

    Container(ai_service, "AI Intelligence Service", "Python 3.11, FastAPI, PyTorch/ONNX, LangChain, FAISS, sentence-transformers", "Executes 384-dimensional text embeddings, online nearest-centroid clustering, vector similarity search, and cited RAG drafting.")

    ContainerQueue(kafka, "Message Broker / Event Stream", "Apache Kafka (KRaft), Topic: questions.incoming", "Provides durable, ordered, event-sourced question ingestion buffer.")

    ContainerDb(postgres, "Relational Database", "PostgreSQL 15+", "Persists user identities, credentials, questions, cluster metadata, resolutions, votes, and video catalog/segment indices.")

    ContainerDb(nas_storage, "Media & Document Storage", "Local Filesystem / NAS Share", "Stores corporate report PDFs, transcode workdir, HLS ladders (1080p, 720p, 480p, 360p), and VTT seek thumbnails.")

    Rel(user, spa, "Interacts with", "HTTPS")
    Rel(spa, api, "REST API calls & Authentication", "HTTPS / JSON (Port 8080)")
    Rel(spa, api, "Live board & room events", "WSS / STOMP over SockJS (/ws)")

    Rel(api, postgres, "Reads and writes transactional entities", "JDBC / SQL (Port 5432)")
    Rel(api, nas_storage, "Writes media files, reads HLS chunks", "POSIX File I/O")

    Rel(api, kafka, "Publishes incoming questions (Kafka mode)", "Kafka Protocol (Port 9092 / 9093)")
    Rel(kafka, ai_service, "Consumes questions for streaming clustering", "Kafka Consumer Protocol")

    Rel(api, ai_service, "Direct ingest, drafting, semantic search", "HTTP / REST (Port 8000)")
    Rel(ai_service, nas_storage, "Loads and indexes regulatory PDFs", "File I/O")
```

### Container Responsibility Matrix

| Container | Runtime | Primary Responsibilities | Scaling Strategy |
|---|---|---|---|
| **Frontend SPA** | Nginx / Vercel / Cloudflare | Reactive UI, Signal state, DOM-level `<video>` coordination, WebSocket subscription | Static Edge CDN cache |
| **Spring Boot Core** | JVM (Container / VM) | Session verification, Question persistence, STOMP fan-out, Video laddering, Voting integrity | Horizontal stateless replicas with Redis STOMP relay |
| **Python AI Service** | Uvicorn / FastAPI | Vector embedding (`all-MiniLM-L6-v2`), online centroid clustering, LangChain FAISS retrieval | Replicated workers with shared FAISS index or pgvector |
| **Apache Kafka** | KRaft mode | Ingest queue decoupling, durability, event replay on boot | Partitioning by `meeting_id` |
| **PostgreSQL** | Managed Postgres | Canonical source of truth for users, questions, cluster curation, ballots | Read replicas for analytics, primary for writes |

---

## 4. C4 Level 3 — Component Diagrams

### 4.1 Backend Core Components (`backend`)

```mermaid
graph TD
    subgraph Spring_Boot_Application ["Spring Boot Core Service"]
        subgraph Security_Boundary ["Security & Identity"]
            JWT[JwtAuthFilter]
            AuthCtrl[AuthController]
            AuthSvc[AuthService]
            TotpSvc[TotpService]
            WebAuthn[WebAuthnService]
        end

        subgraph Ingestion_Pipeline ["Question Ingestion & Clustering"]
            QCtrl[QuestionController]
            QSvc[QuestionService]
            KafkaProd[KafkaQuestionProducer]
            DraftWorker[ClusterDraftWorker]
            DraftSvc[ClusterDraftService]
            CurationSvc[ClusterCurationService]
            AiClnt[AiClient]
            BoardSched[BoardRefreshScheduler]
        end

        subgraph Voting_Engine ["Voting & Ballots"]
            VoteCtrl[VotingController]
            VoteSvc[VotingService]
        end

        subgraph Video_Subsystem ["HLS Video Library"]
            VidCtrl[VideoController]
            VidAdmin[VideoAdminController]
            VidLibSvc[VideoLibraryService]
            VidProcWorker[VideoProcessingWorker]
            VidTranscode[VideoTranscodeService]
            VidStore[VideoStorageService]
            TicketSvc[PlaybackTicketService]
        end

        subgraph Realtime_Broker ["WebSocket Broker"]
            WSConfig[WebSocketConfig]
            MsgTemplate[SimpMessagingTemplate]
        end
    end

    QCtrl --> QSvc
    QSvc --> KafkaProd
    QSvc --> AiClnt
    QSvc --> DraftWorker
    DraftWorker --> AiClnt
    DraftWorker --> MsgTemplate
    BoardSched --> AiClnt
    BoardSched --> MsgTemplate
    QSvc --> CurationSvc
    VoteCtrl --> VoteSvc
    VidAdmin --> VidLibSvc
    VidLibSvc --> VidProcWorker
    VidProcWorker --> VidTranscode
    VidCtrl --> TicketSvc
    VidCtrl --> VidStore
```

### 4.2 Python AI Service Components (`ai-service`)

```mermaid
graph TD
    subgraph FastAPI_AI_Service ["FastAPI AI Service"]
        API_Router[main.py Endpoints]

        subgraph Clustering_Engine ["Online Centroid Clustering"]
            Clusterer[OnlineClusterer]
            CentroidStore[(In-Memory Cluster Centroids)]
        end

        subgraph Embedding_Engine ["Vector Embeddings"]
            Embedder[sentence-transformers: all-MiniLM-L6-v2]
        end

        subgraph RAG_Engine ["Grounded Answering (RAG)"]
            RAGChain[LangChain Grounded Chain]
            FAISSStore[(FAISS Vector Index)]
            DocLoader[PDF Chunk Resolver]
            LLMGateway[LLM Provider: Groq / Gemini]
        end

        subgraph Kafka_Worker ["Event Stream Consumer"]
            KafkaStream[kafka_stream.py Replay & Live Consumer]
        end
    end

    API_Router --> Clusterer
    API_Router --> RAGChain
    KafkaStream --> Clusterer
    KafkaStream --> RAGChain
    Clusterer --> Embedder
    Clusterer --> CentroidStore
    RAGChain --> Embedder
    RAGChain --> FAISSStore
    RAGChain --> LLMGateway
    DocLoader --> FAISSStore
```

### 4.3 Frontend Reactive Components (`frontend`)

```mermaid
graph TD
    subgraph Angular_SPA ["Angular 19+ Reactive Frontend"]
        subgraph Services ["Core Services (Signals & Inversion of Control)"]
            AuthService[AuthService: JWT, Session, Role Signal]
            BoardService[BoardService: STOMP Client, Top Clusters Signal]
            PlayerHostService[PlayerHostService: Document-level Video Positioning & PiP Heuristics]
            VideoService[VideoService: HLS Quality, Upload & Manifests]
            VotingService[VotingService: Active Resolution & Ballot Signals]
        end

        subgraph Presentational_Pages ["Routable Component Pages"]
            AttendeeComp[AttendeeComponent: Submit Question, Feedback]
            BoardComp[BoardComponent: Ranked Clusters, Draft Inspection, Publishing]
            VideoPlayerComp[VideoPlayerComponent: HLS.js custom controls]
            VotingComp[VotingComponent: Resolution Ballot & Results]
            LoungeComp[LoungeComponent: Chat & Pre-meeting Activity]
        end

        AppComp[AppComponent: Top-level Host of Universal Video Element]
    end

    AppComp --> PlayerHostService
    VideoPlayerComp --> PlayerHostService
    BoardComp --> BoardService
    AttendeeComp --> AuthService
    VotingComp --> VotingService
    VideoPlayerComp --> VideoService
```

---

## 5. C4 Level 4 — Detailed Operational Workflows

### 5.1 Real-Time Question Ingest, Dedup, and Background Drafting

```mermaid
sequenceDiagram
    autonumber
    actor Attendee
    participant SPA as Angular SPA
    participant API as Spring Boot API
    participant DB as PostgreSQL
    participant Kafka as Kafka (questions.incoming)
    participant AI as AI Service (FastAPI)
    participant Worker as ClusterDraftWorker
    participant STOMP as WebSocket /topic/board
    actor Moderator

    Attendee->>SPA: Types question: "Will dividends increase?"
    SPA->>API: POST /api/questions/submit-question
    Note over API: 1. Audit safety: Persist raw question first
    API->>DB: INSERT INTO questions (status='RECEIVED', meeting_id, text)

    alt Mode A: HTTP Synchronous Ingest
        API->>AI: POST /ingest {text, attendee_id, weight, meeting_id}
        AI->>AI: Embed text (384-dim)
        AI->>AI: Calculate cosine similarity against existing meeting centroids
        alt Sim >= 0.78
            AI-->>API: {cluster_id, is_new: false, size: N+1}
        else Sim < 0.78
            AI-->>API: {cluster_id: new_uuid, is_new: true, size: 1}
        end
        API->>DB: UPDATE questions SET cluster_id = :cluster_id
        API-->>SPA: Return IngestResult to Attendee
        API->>Worker: enqueue(cluster_id, text, meeting_id)
        Worker-->>AI: POST /draft (Async off-thread)
        AI->>AI: FAISS retrieval -> LLM answer with citations
        AI-->>Worker: {draft_answer, citations}
        Worker->>STOMP: Broadcast updated board
    else Mode B: Kafka Event Stream
        API->>Kafka: publish(question_id, text, attendee_id, weight)
        API-->>SPA: Return IngestResult {cluster_id: 'pending'}
        Kafka->>AI: Consumer pulls question event
        AI->>AI: Embed, assign centroid, and trigger auto-draft
    end

    STOMP-->>Moderator: Real-time board update with cited answer
```

### 5.2 Picture-in-Picture & Safe Route Transitions

To prevent browser W3C Picture-in-Picture sessions from aborting on navigation, the application strictly adheres to the following DOM layout:

```
[Document Root / AppComponent]
  ├── <header> Global Navigation </header>
  ├── <main> <router-outlet /> </main>   <-- Pages mount/unmount here (/ask, /board, /voting)
  └── <div class="player-host">
        └── <video #globalPlayer>       <-- NEVER unmounted; absolute positioned by PlayerHostService
```

```mermaid
stateDiagram-v2
    [*] --> InPlayerRoute: Navigate to /recordings?v=XYZ
    InPlayerRoute --> FloatingPiP: User navigates away to /ask or /board
    FloatingPiP --> InteractiveWork: User types question or moderates board
    InteractiveWork --> PiPClosedOrReturned: PiP window clicked or closed
    
    state PiPClosedOrReturned {
        [*] --> CheckCurrentRoute
        CheckCurrentRoute --> StayOnCurrentPage: Current route is active interactive page (/ask, /board)
        CheckCurrentRoute --> NavigateBackToVideo: Current route was idle/welcome
    }
```

---

## 6. Architectural Decision Records (ADRs)

### ADR-01: Polyglot Microservices Architecture
* **Context**: Need high-concurrency WebSocket broadcast, enterprise role-based security, and native AI/vector math.
* **Decision**: 
  - **Angular 19+**: Chosen for compile-time type safety, Signals-based zoneless reactivity, and real-time board rendering.
  - **Spring Boot 3.x**: Chosen for enterprise security (JWT, BCrypt, WebAuthn, TOTP), transactional data integrity, and multi-threaded WebSocket fan-out.
  - **Python FastAPI**: Chosen because the PyTorch, LangChain, FAISS, and sentence-transformers ecosystem natively resides in Python.
* **Consequences**: Requires well-defined HTTP/Kafka contracts between Java and Python.

### ADR-02: Document-Level `<video>` Preservation for PiP
* **Context**: Moving a `<video>` element across DOM hierarchies or unmounting it during Angular route changes causes the browser W3C PiP implementation to automatically terminate the picture-in-picture window.
* **Decision**: The `<video>` tag is mounted once at the `AppComponent` root and positioned over placeholder rectangles in `VideoPlayerComponent` using document coordinates.
* **Consequences**: Smooth PiP multitasking across tabs; requires coordinate synchronization on window resize.

### ADR-03: Durable Persistence Before Messaging
* **Context**: If Kafka or AI services experience transient network disconnects, questions submitted by shareholders could be permanently lost.
* **Decision**: All question submissions are written to PostgreSQL with status `RECEIVED` **prior** to invoking Kafka or HTTP ingest.
* **Consequences**: Zero question loss under network partition; ingestion can always be replayed.

### ADR-04: Fail-Fast Messaging Configuration
* **Context**: Default Kafka producer timeout in Spring is 60 seconds. A broker outage would lock HTTP worker threads, leading to thread pool exhaustion and cascading failures.
* **Decision**: Configured `max.block.ms=3000`, `request.timeout.ms=3000`, and `delivery.timeout.ms=5000` with dual listener configuration (`PLAINTEXT` and `PLAINTEXT_HOST`).
* **Consequences**: Failures surface in $<3$ seconds without exhausting server threads.

### ADR-05: Off-Thread LLM Answering on Cluster Creation
* **Context**: LLM inference takes 1.5–4.0 seconds. Blocking attendee submission for drafting degrades user experience. Waiting for moderators to manually click "Draft" causes delay in high-velocity meetings.
* **Decision**: `ClusterDraftWorker` auto-triggers drafting asynchronously in the background as soon as a cluster is initialized.
* **Consequences**: Answers are pre-grounded with citations before moderators even open the card.

---

## 7. Security Architecture & Threat Model

```mermaid
flowchart LR
    subgraph Untrusted_Zone ["Untrusted Public Network"]
        Client[Browser / Client]
    end

    subgraph DMZ ["Edge / Reverse Proxy"]
        SSL[TLS Termination & CORS]
    end

    subgraph Trust_Zone_1 ["Application Layer (Spring Boot)"]
        Filter[JwtAuthFilter]
        RBAC[Spring Security RBAC]
        RateLimit[Rate Limiter]
    end

    subgraph Trust_Zone_2 ["Internal Services"]
        DB[(PostgreSQL)]
        AI_SVC[FastAPI AI]
        Kafka_Bus[Kafka Broker]
    end

    Client -->|HTTPS / WSS| SSL
    SSL --> Filter
    Filter --> RateLimit
    RateLimit --> RBAC
    RBAC --> DB
    RBAC --> AI_SVC
    RBAC --> Kafka_Bus
```

1. **Authentication**: Stateless HMAC-SHA256 JWT tokens with role claims (`ATTENDEE`, `SHAREHOLDER`, `MODERATOR`, `ADMIN`).
2. **Two-Factor Authentication**: TOTP RFC 6238 and FIDO2/WebAuthn hardware passkeys for administrative and moderator actions.
3. **Voting Non-Repudiation**: Ballots require authenticated `SHAREHOLDER` tokens with server-verified shareholding weights copied at ballot casting time, preventing retrospective vote tampering.
4. **Media Security**: Video recordings use short-lived, video-scoped HMAC playback tickets (`PlaybackTicketService`), preventing direct unauthorized hotlinking of NAS media bytes.

---

## 8. Summary Topology & Verification

| Metric | Specification | Verification Method |
|---|---|---|
| **Max Concurrent WebSocket Listeners** | 10,000+ | Non-blocking STOMP topic broadcast |
| **Dedup Cosine Threshold** | 0.78 (`all-MiniLM-L6-v2`) | Unit tested in `test_clustering.py` |
| **Max RAG Answer Length** | 120 words | Prompt constraint in `rag.py` |
| **Kafka Broker Failover Time** | $\le 3000$ ms | Spring Kafka producer timeout config |
| **Video Ladder Bitrates** | 1080p (4.5M), 720p (2.2M), 480p (800k), 360p (400k) | Verified via FFmpeg transcode pipeline |
