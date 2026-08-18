package com.agmsentinel.controller;

import com.agmsentinel.service.AiClient;
import org.springframework.http.ResponseEntity;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Liveness, and a deliberate way to wake the AI service.
 *
 * <h2>Why this had to exist</h2>
 * {@code SecurityConfig} has always permitted {@code /health} without authentication — but nothing
 * was mapped there, so it answered 404. An operator pointing an uptime monitor at it would see a
 * permanent failure, conclude the monitor was misconfigured, and delete it. The rule promised
 * something the application did not provide.
 *
 * <h2>Two endpoints, because they answer different questions</h2>
 * <ul>
 *   <li>{@code /health} — is this process alive? Never touches the AI service, so a monitor pinging
 *       it cannot itself be slowed down by a dependency, and a failure here means the backend is
 *       genuinely down rather than merely degraded.
 *   <li>{@code /health/ai} — is the AI service reachable? This one <em>does</em> call it, which is
 *       the point: on a free tier where it sleeps when idle, an external cron hitting this every
 *       few minutes is the only thing that reliably keeps it awake.
 * </ul>
 *
 * <p>The in-application keep-warm cannot do that job on its own. It only runs while this process is
 * running, and on a free tier the backend sleeps too — so the pinger goes to sleep alongside the
 * thing it is meant to be keeping awake. Only something outside both survives that.
 *
 * <p>GET rather than POST, unlike the rest of the API: uptime monitors send GET, and an endpoint
 * that exists for them should speak their language.
 */
@RestController
public class HealthController {

    /**
     * When this process came up.
     *
     * <p>A constant captured at class load, not a field written later: the point is to say how long
     * this exact JVM has been serving, which is the fastest way to tell "the deploy landed" from
     * "you are still talking to the old container". On a platform that redeploys without the
     * version changing, this is the half that actually answers the question.
     */
    private static final Instant STARTED_AT = Instant.now();

    private final AiClient ai;

    /** The Maven project version, injected by Spring Boot's build-info property. */
    @Value("${spring.application.version:unknown}")
    private String version;

    public HealthController(AiClient ai) {
        this.ai = ai;
    }

    /**
     * Alive, and which build is answering. Deliberately consults nothing that could be slow.
     *
     * <p>The version is here for the same reason the frontend stamps its footer: telling a deployed
     * build from a stale one otherwise meant probing for a behaviour change and inferring backwards,
     * which gets the answer wrong as often as right. {@code version} is the Maven project version;
     * {@code startedAt} is when this process came up, which is the more useful of the two on a host
     * that redeploys without the version changing.
     */
    @GetMapping({"/health", "/api/health"})
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "UP");
        body.put("version", version);
        body.put("startedAt", STARTED_AT.toString());
        return body;
    }

    /**
     * Reachability of the AI service — and, as a side effect, a request that wakes it.
     *
     * <p>Returns 200 with {@code ai: "DOWN"} rather than a 503 when it cannot be reached. A monitor
     * pointed here is measuring whether the wake-up call was delivered, not whether the dependency
     * happened to be awake beforehand — and on a free tier the first call after idle is *expected*
     * to find it asleep. Answering 503 there would alert on normal behaviour, which trains people
     * to ignore the alert.
     */
    @GetMapping("/health/ai")
    public ResponseEntity<Map<String, Object>> aiHealth() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "UP");
        long started = System.currentTimeMillis();
        try {
            ai.knowledgeStatus();
            body.put("ai", "UP");
        } catch (RuntimeException ex) {
            body.put("ai", "DOWN");
            body.put("reason", ex.getClass().getSimpleName());
        }
        body.put("ms", System.currentTimeMillis() - started);
        return ResponseEntity.ok(body);
    }
}
