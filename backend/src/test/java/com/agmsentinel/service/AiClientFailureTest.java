package com.agmsentinel.service;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.ServerSocket;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

/**
 * What the backend does when the AI service is not there.
 *
 * <h2>Why this test exists</h2>
 * A user hit {@code /api/chat/semantic-search} while the AI service was down and got this:
 *
 * <pre>{@code {"status":500,"error":"Internal Server Error","path":"/api/chat/semantic-search"}}</pre>
 *
 * No {@code message} field — so the SPA had nothing to display — and no log line on the server
 * either, because {@code AiClient} had no logger at all. Every one of its twelve methods ended in a
 * bare {@code .block()} whose exception reached no handler. An outage was indistinguishable from a
 * bug, and left no evidence behind.
 *
 * <p>These cases pin down the two things that were wrong: the status must say the DEPENDENCY failed
 * (503, retryable) rather than blaming the request (500), and the message must be a sentence a
 * person can act on.
 */
class AiClientFailureTest {

    /** A port with nothing listening, so connecting is refused immediately. */
    private static String deadBaseUrl;

    @BeforeAll
    static void findAClosedPort() throws IOException {
        // Bind to port 0 to have the OS pick a free one, then release it. Far more reliable than
        // guessing a port number and finding something already using it on a developer's machine.
        try (ServerSocket probe = new ServerSocket(0)) {
            deadBaseUrl = "http://127.0.0.1:" + probe.getLocalPort();
        }
    }

    private AiClient client() {
        return new AiClient(deadBaseUrl, new ReactorClientHttpConnector());
    }

    @Test
    void semanticSearchReportsTheOutageInsteadOfFailingBlankly() {
        ResponseStatusException thrown =
                catchThrowableOfType(ResponseStatusException.class,
                                     () -> client().search("dividend", 5, null));
        assertThat(thrown).as("a failed AI call must raise a status, not a raw exception").isNotNull();

        // 503, not 500: the request was fine, the dependency was not — and 503 tells the caller
        // that trying again is a sensible thing to do, which 500 does not.
        assertThat(thrown.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        // A sentence, naming what failed. This is the part that was missing entirely.
        assertThat(thrown.getReason())
                .contains("AI service")
                .contains("semantic search");
    }

    @Test
    void theAssistantAndTheBoardFailTheSameWay() {
        // The bug was never specific to search — every call shared the same missing handling, so
        // every call is worth pinning rather than only the one that happened to be reported.
        assertThatThrownBy(() -> client().chat("hello", null))
                .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> client().clusters(10, null))
                .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> client().knowledgeStatus())
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void bestEffortHousekeepingDoesNotBringDownTheCallerThatDependsOnIt() {
        // retainMeeting only clears a cache of centroids. Activating a meeting must not fail
        // because that cache could not be cleared — the centroids are rebuildable and the durable
        // record lives in Postgres. So this one swallows and logs where the others throw.
        assertThatCode(() -> client().retainMeeting(UUID.randomUUID()))
                .doesNotThrowAnyException();
    }
}
