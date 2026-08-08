package com.agmsentinel.service;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.dto.ChatDtos.AiChatResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.ExchangeStrategies;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Thin HTTP client over the Python AI service (embedding, clustering, RAG). */
@Component
public class AiClient {

    private final WebClient web;

    public AiClient(@Value("${ai.service.url:http://localhost:8000}") String baseUrl,
                    ReactorClientHttpConnector connector) {
        // Raise WebClient's default 256KB in-memory buffer. fetchKnowledgeFile() reads a
        // whole proxied PDF into a byte[], and real annual-report PDFs exceed 256KB — which
        // otherwise throws DataBufferLimitException → 500 when a user opens a citation link.
        // 32MB covers the 25MB upload ceiling (see application.yml) with headroom; the other
        // calls return small JSON, so the larger limit costs nothing.
        ExchangeStrategies strategies = ExchangeStrategies.builder()
                .codecs(c -> c.defaultCodecs().maxInMemorySize(32 * 1024 * 1024))
                .build();
        this.web = WebClient.builder()
                .baseUrl(baseUrl)
                .exchangeStrategies(strategies)
                // Explicit connector rather than reactor-netty's global defaults — those have no
                // idle eviction, no connect timeout and no response timeout, each of which fails
                // intermittently in a way that looks like flakiness. See AiWebClientConfig.
                .clientConnector(connector)
                .build();
    }

    /**
     * Embed and cluster one question.
     *
     * <p>{@code meetingId} partitions the clustering: the AI service compares this question only
     * against centroids from the same meeting. Without it, a question at this year's AGM would be
     * folded into a topic from last year's — not a tidiness problem but a wrong answer, and one
     * invisible until somebody reads the board and finds a question nobody asked.
     *
     * <p>Sent unconditionally, whether or not the MEETINGS flag is on, for the same reason the
     * backend stamps {@code meeting_id} unconditionally: partitioning that followed the flag would
     * leave everything ingested with it off in the wrong partition the moment it was switched on.
     */
    public IngestResult ingest(String questionId, String text, String attendeeId, float weight,
                               UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("question_id", questionId);
        body.put("text", text);
        body.put("attendee_id", attendeeId);
        body.put("weight", weight);
        // HashMap rather than Map.of: the meeting is genuinely absent when none is active, and
        // Map.of rejects a null value outright.
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());

        return web.post().uri("/ingest")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(IngestResult.class)
                .timeout(Duration.ofSeconds(30))   // generous: covers free-tier cold starts
                .block();
    }

    public DraftResult draft(String clusterId, String representativeQuestion) {
        return draft(clusterId, representativeQuestion, null);
    }

    /**
     * Draft an answer, grounded only in what this meeting may cite.
     *
     * <p>{@code meetingId} confines retrieval to that meeting's documents plus the shared ones. A
     * null searches everything, which is what an unscoped deployment gets and what this method did
     * before scoping existed.
     */
    public DraftResult draft(String clusterId, String representativeQuestion, UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("cluster_id", clusterId);
        body.put("representative_question", representativeQuestion);
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());

        return web.post().uri("/draft")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(DraftResult.class)
                .timeout(Duration.ofSeconds(60))
                .block();
    }

    /** GenAI assistant: RAG-grounded answer to a shareholder's free-form message. */
    public AiChatResult chat(String message) {
        return chat(message, null);
    }

    /** The assistant, answering from this meeting's documents plus the shared ones. */
    public AiChatResult chat(String message, UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("message", message);
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());

        return web.post().uri("/chat")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(AiChatResult.class)
                .timeout(Duration.ofSeconds(60))
                .block();
    }

    /** Forward an uploaded annual-report PDF to the AI service for runtime RAG indexing. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> uploadKnowledge(String filename, byte[] bytes) {
        return uploadKnowledge(filename, bytes, null);
    }

    /**
     * Index a document, optionally scoped to one meeting.
     *
     * <p>A null meeting makes it <b>shared</b> — retrievable by every meeting. That is the right
     * default for the articles, a standing policy or a reference report, and it is why a document
     * uploaded without choosing a meeting shows up against a brand-new one.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> uploadKnowledge(String filename, byte[] bytes, UUID meetingId) {
        MultipartBodyBuilder builder = new MultipartBodyBuilder();
        builder.part("file", new ByteArrayResource(bytes) {
            @Override
            public String getFilename() {
                return filename;   // required so the AI service sees a .pdf filename
            }
        }).contentType(MediaType.APPLICATION_PDF);

        // Only sent when there is one: the AI service reads an absent field as "shared", and an
        // empty string would be a meeting id that matches nothing.
        if (meetingId != null) builder.part("meeting_id", meetingId.toString());

        return web.post().uri("/knowledge/upload")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(BodyInserters.fromMultipartData(builder.build()))
                .retrieve()
                .bodyToMono(Map.class)
                // Sized for a genuinely large document, not a typical one. A 1,000-page PDF
                // splits into tens of thousands of chunks and every one is embedded; two minutes
                // is not close. When this expires the AI service KEEPS WORKING — it never learns
                // the caller left — so a short timeout does not stop the indexing, it only stops
                // anyone watching it. The UI polls the run's own progress and no longer depends on
                // this response arriving.
                .timeout(Duration.ofMinutes(10))
                .block();
    }

    private Map<String, Object> removalBody(String filename, UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("filename", filename);
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());
        return body;
    }

    /** Fetch the raw bytes of an indexed source PDF (proxied to the browser for citation links). */
    public byte[] fetchKnowledgeFile(String filename) {
        return web.get().uri("/knowledge/files/{name}", filename)
                .retrieve()
                .bodyToMono(byte[].class)
                .timeout(Duration.ofSeconds(30))
                .block();
    }

    /**
     * Index a recording's captions into the RAG knowledge base.
     *
     * <p>The VTT text is sent rather than a path: the AI service has no access to the media, which
     * may be on a NAS share or in the database. Small enough to post as JSON — even a three-hour
     * transcript is a couple of hundred kilobytes.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> indexTranscript(String videoId, String title, String webVtt) {
        return indexTranscript(videoId, title, webVtt, null);
    }

    /**
     * Index a recording's captions, optionally scoped to one meeting.
     *
     * <p>A null meeting shares the transcript with every meeting. That is the safer default for a
     * recording whose meeting is not known — a document nobody can find is worse than one a second
     * meeting can also cite.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> indexTranscript(String videoId, String title, String webVtt,
                                               UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("video_id", videoId);
        body.put("title", title);
        body.put("vtt", webVtt);
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());

        return web.post().uri("/knowledge/transcript")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(120))   // embedding a long transcript takes a moment
                .block();
    }

    /**
     * Transcribe an extracted audio track, returning WebVTT.
     *
     * <p>Multipart because the audio is binary and would inflate by a third as base64. The timeout is
     * generous: a hosted speech model working through an hour of audio takes longer than any other
     * call this client makes, and a premature abort would waste the upload.
     *
     * @return the WebVTT document, or null when the service has no transcription configured
     */
    @SuppressWarnings("unchecked")
    public String transcribeAudio(String filename, byte[] audio) {
        MultipartBodyBuilder builder = new MultipartBodyBuilder();
        builder.part("file", new ByteArrayResource(audio) {
            @Override
            public String getFilename() {
                return filename;   // the provider infers the container from the extension
            }
        });

        Map<String, Object> body = web.post().uri("/transcribe")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(BodyInserters.fromMultipartData(builder.build()))
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofMinutes(10))
                .block();

        Object vtt = body == null ? null : body.get("vtt");
        return vtt instanceof String text && !text.isBlank() ? text : null;
    }

    /**
     * Semantic search over the knowledge base — retrieval with no generation.
     *
     * <p>Short timeout on purpose: this is a vector lookup, not a model call. It needs no API key
     * and costs nothing per query, which is what makes it usable as you type rather than as a
     * deliberate, expensive action.
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> search(String query, int k) {
        return search(query, k, null);
    }

    /** Semantic search across this meeting's documents plus the shared ones. */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> search(String query, int k, UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("query", query == null ? "" : query);
        body.put("k", k);
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());

        return web.post().uri("/search")
                .bodyValue(body)
                .retrieve()
                .bodyToFlux(Map.class)
                .collectList()
                .map(list -> (List<Map<String, Object>>) (List<?>) list)
                .timeout(Duration.ofSeconds(20))
                .block();
    }

    /**
     * Read the knowledge-base status.
     *
     * <p>The timeout is sized for a <em>sleeping</em> AI service, not a warm one. Warm, this call
     * answers in about half a second; cold on a free-tier host it takes roughly forty, because the
     * container has to start and the service then loads the embedding model and rebuilds the FAISS
     * index before it serves anything. The previous fifteen seconds was therefore guaranteed to
     * fail on the first request after an idle period — which is exactly when a moderator opens the
     * Setup page — and the failure surfaced as "is the AI service awake?" with no way to wait.
     */
    public Map<String, Object> knowledgeStatus() {
        return web.get().uri("/knowledge/status")
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(60))
                .block();
    }

    /**
     * Drop one indexed document from the RAG knowledge base — its file, its chunks and its vectors.
     *
     * <p>The AI service deletes the stored file and then rebuilds the index from the documents that
     * remain, because a FAISS index has no per-document delete. That makes removal cost the same as
     * an upload rather than the same as a status read, which is why the timeout matches
     * {@link #indexTranscript} at two minutes instead of the fifteen seconds
     * {@link #knowledgeStatus} allows.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> removeKnowledgeSource(String filename) {
        return removeKnowledgeSource(filename, null);
    }

    /**
     * Remove a document, telling the AI service which meeting is live.
     *
     * <p>The AI service refuses when the document belongs to a different meeting — it owns the
     * manifest, so it is the only place that knows. Enforced there rather than in the UI, because a
     * check the client performs is a check the client can skip.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> removeKnowledgeSource(String filename, UUID meetingId) {
        return web.post().uri("/knowledge/remove")
                .bodyValue(removalBody(filename, meetingId))
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(120))   // the whole index is re-embedded from disk
                .block();
    }

    /** Every meeting's topics, merged and re-ranked. The unscoped board. */
    public List<ClusterView> clusters(int limit) {
        return clusters(limit, null);
    }

    /**
     * The ranked board, optionally for one meeting.
     *
     * <p>Omitting {@code meetingId} means <em>all</em> meetings merged, not "the meeting-less
     * ones" — that asymmetry is deliberate and documented on the Python side too, because the
     * alternative silently turns a request for one meeting's board into a request for every
     * meeting's.
     */
    public List<ClusterView> clusters(int limit, UUID meetingId) {
        return web.get().uri(uri -> {
                    uri.path("/clusters").queryParam("limit", limit);
                    if (meetingId != null) uri.queryParam("meeting_id", meetingId.toString());
                    return uri.build();
                })
                .retrieve()
                .bodyToFlux(ClusterView.class)
                .collectList()
                .timeout(Duration.ofSeconds(30))
                .block();
    }

    /**
     * Tell the AI service to keep only this meeting's clustering state.
     *
     * <p>Called when a meeting is activated, so the new meeting starts genuinely clean rather than
     * merely filtered — and so memory does not grow with every meeting ever run.
     *
     * <p>Best effort by design. Losing this call means stale centroids linger in memory; it does
     * not mean anything is wrong with the meeting, and refusing to activate because a cache could
     * not be cleared would be the wrong trade entirely. The centroids are rebuildable and the
     * durable record is in {@code cluster_drafts}.
     */
    public void retainMeeting(UUID meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("meeting_id", meetingId == null ? null : meetingId.toString());
        web.post().uri("/meetings/retain")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(20))
                .block();
    }
}
