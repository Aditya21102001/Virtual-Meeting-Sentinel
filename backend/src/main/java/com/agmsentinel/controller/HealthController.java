package com.agmsentinel.controller;

import com.agmsentinel.service.AiClient;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

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

    private final AiClient ai;

    public HealthController(AiClient ai) {
        this.ai = ai;
    }

    /** Alive. Deliberately answers without consulting anything that could be slow. */
    @GetMapping({"/health", "/api/health"})
    public Map<String, Object> health() {
        return Map.of("status", "UP");
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
