package com.agmsentinel.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;

/**
 * Pings the AI service at a fixed interval so it never hits an idle timeout.
 *
 * <h2>Why this exists alongside {@link AiWarmupService}</h2>
 * {@code AiWarmupService} wakes the AI service <em>reactively</em> when someone signs in. That
 * covers the case where the backend is already warm and a user arrives. But if <em>nobody</em>
 * signs in for 15+ minutes, both services go cold — and the next visitor pays two cold starts
 * in sequence (backend → AI).
 *
 * This scheduler runs <em>while the backend process is alive</em>, unconditionally pinging
 * {@code /health} every 8 minutes. As long as the backend is up, the AI service stays up.
 *
 * <p>The remaining gap is the backend itself sleeping — that's what the external
 * {@code .github/workflows/keep-warm.yml} cron covers. Together the two form a complete
 * keep-alive chain:
 * <pre>
 *   GitHub Actions (every 10 min) → wakes Backend
 *   Backend KeepAliveScheduler (every 8 min) → wakes AI service
 * </pre>
 *
 * <h2>Why not ping from the cron directly?</h2>
 * The AI service may be on a private network (Docker Compose, VPC). The backend can always
 * reach it; a GitHub Actions runner cannot. Letting the backend relay the keep-alive means
 * the cron only needs one public URL.
 *
 * <h2>Cost</h2>
 * {@code /health} returns a static JSON object, touches no model, no database, and no
 * provider API. At 6 pings per hour, the network cost is effectively zero.
 *
 * <h2>Configuration</h2>
 * <ul>
 *   <li>{@code keep-alive.interval-ms} — ping interval in milliseconds (default 480000 = 8 min).
 *       Set to a value comfortably below your host's idle timeout.</li>
 *   <li>{@code keep-alive.enabled} — set to {@code false} to disable entirely, e.g. in tests
 *       or when both services are on always-on infrastructure.</li>
 * </ul>
 */
@Component
public class KeepAliveScheduler {

    private static final Logger log = LoggerFactory.getLogger(KeepAliveScheduler.class);

    private static final Duration PING_TIMEOUT = Duration.ofSeconds(15);

    private final WebClient web;
    private final boolean enabled;

    public KeepAliveScheduler(
            WebClient.Builder builder,
            @Value("${ai.service.url:http://localhost:8000}") String aiBaseUrl,
            @Value("${keep-alive.enabled:true}") boolean enabled) {
        this.web = builder.baseUrl(aiBaseUrl).build();
        this.enabled = enabled;
    }

    /**
     * Periodic keep-alive ping. Runs on a fixed delay so the interval is measured from the
     * <em>end</em> of each ping, not the start — a slow response shifts the next attempt
     * forward rather than stacking up.
     */
    @Scheduled(
        fixedDelayString = "${keep-alive.interval-ms:240000}",
        initialDelayString = "${keep-alive.initial-delay-ms:30000}"
    )
    public void pingAiService() {
        if (!enabled) return;

        try {
            web.get().uri("/health")
               .retrieve()
               .toBodilessEntity()
               .timeout(PING_TIMEOUT)
               .block();
            log.debug("AI service keep-alive ping: OK");
        } catch (RuntimeException e) {
            // WARN, not ERROR — the service may be rebooting; next tick will retry.
            log.warn("AI service keep-alive ping failed: {}", e.getMessage());
        }
    }
}

