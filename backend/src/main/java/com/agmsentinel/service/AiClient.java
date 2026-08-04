package com.agmsentinel.service;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.dto.ChatDtos.AiChatResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.ExchangeStrategies;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/** Thin HTTP client over the Python AI service (embedding, clustering, RAG). */
@Component
public class AiClient {

    private final WebClient web;

    public AiClient(@Value("${ai.service.url:http://localhost:8000}") String baseUrl) {
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
                .build();
    }

    public IngestResult ingest(String questionId, String text, String attendeeId, float weight) {
        return web.post().uri("/ingest")
                .bodyValue(Map.of(
                        "question_id", questionId,
                        "text", text,
                        "attendee_id", attendeeId,
                        "weight", weight))
                .retrieve()
                .bodyToMono(IngestResult.class)
                .timeout(Duration.ofSeconds(30))   // generous: covers free-tier cold starts
                .block();
    }

    public DraftResult draft(String clusterId, String representativeQuestion) {
        return web.post().uri("/draft")
                .bodyValue(Map.of(
                        "cluster_id", clusterId,
                        "representative_question", representativeQuestion))
                .retrieve()
                .bodyToMono(DraftResult.class)
                .timeout(Duration.ofSeconds(60))
                .block();
    }

    /** GenAI assistant: RAG-grounded answer to a shareholder's free-form message. */
    public AiChatResult chat(String message) {
        return web.post().uri("/chat")
                .bodyValue(Map.of("message", message))
                .retrieve()
                .bodyToMono(AiChatResult.class)
                .timeout(Duration.ofSeconds(60))
                .block();
    }

    /** Forward an uploaded annual-report PDF to the AI service for runtime RAG indexing. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> uploadKnowledge(String filename, byte[] bytes) {
        MultipartBodyBuilder builder = new MultipartBodyBuilder();
        builder.part("file", new ByteArrayResource(bytes) {
            @Override
            public String getFilename() {
                return filename;   // required so the AI service sees a .pdf filename
            }
        }).contentType(MediaType.APPLICATION_PDF);

        return web.post().uri("/knowledge/upload")
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .body(BodyInserters.fromMultipartData(builder.build()))
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(120))   // embedding a full report takes a moment
                .block();
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
        return web.post().uri("/knowledge/transcript")
                .bodyValue(Map.of("video_id", videoId, "title", title, "vtt", webVtt))
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

    public Map<String, Object> knowledgeStatus() {
        return web.get().uri("/knowledge/status")
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(15))
                .block();
    }

    public List<ClusterView> clusters(int limit) {
        return web.get().uri(uri -> uri.path("/clusters").queryParam("limit", limit).build())
                .retrieve()
                .bodyToFlux(ClusterView.class)
                .collectList()
                .timeout(Duration.ofSeconds(30))
                .block();
    }
}
