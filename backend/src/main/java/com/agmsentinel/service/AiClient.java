package com.agmsentinel.service;

import com.agmsentinel.dto.Dtos.*;
import com.agmsentinel.dto.ChatDtos.AiChatResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/** Thin HTTP client over the Python AI service (embedding, clustering, RAG). */
@Component
public class AiClient {

    private final WebClient web;

    public AiClient(@Value("${ai.service.url:http://localhost:8000}") String baseUrl) {
        this.web = WebClient.builder().baseUrl(baseUrl).build();
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
