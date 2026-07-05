package com.agmsentinel.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

/** All request/response records for the API, kept together for readability. */
public final class Dtos {
    private Dtos() { }

    // ---- inbound from Angular attendees --------------------------------------
    public record SubmitQuestionRequest(
            @NotBlank @Size(max = 1000) String text,
            @NotBlank String attendeeId,
            float weight
    ) { }

    // ---- AI service /ingest response -----------------------------------------
    public record IngestResult(
            String question_id,
            String cluster_id,
            boolean is_new_cluster,
            double similarity,
            int cluster_size
    ) { }

    // ---- AI service /draft response ------------------------------------------
    public record Citation(String source, String snippet) { }
    public record DraftResult(String cluster_id, String answer, List<Citation> citations) { }

    // ---- AI service /clusters item (board) -----------------------------------
    public record ClusterView(
            String cluster_id,
            String representative_question,
            int size,
            double priority_score,
            String draft,
            List<Citation> citations
    ) { }

    // ---- broadcast to moderators over WebSocket ------------------------------
    public record BoardUpdate(String type, List<ClusterView> clusters) { }

    // ---- auth ----------------------------------------------------------------
    public record LoginRequest(@NotBlank String username, @NotBlank String role) { }
    public record TokenResponse(String token) { }
}
