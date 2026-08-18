package com.agmsentinel.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Wakes the AI service in the background when somebody signs in.
 *
 * <h2>Why signing in is the right trigger</h2>
 * The AI service sleeps when idle. The first person to open chat, drafting or semantic search
 * therefore pays a cold start of tens of seconds — and, worse, sees it as a failure rather than a
 * wait. Signing in is the earliest moment we know a human is about to use the application, and it is
 * far enough ahead of them reaching an AI feature that the wake is usually finished by the time they
 * get there. Nothing about it is visible: it neither blocks the login nor reports anything.
 *
 * <h2>Why it pings {@code /health} rather than a real endpoint</h2>
 * Waking a service only requires a request to arrive. {@code /health} touches no model and no
 * database, so it costs the service almost nothing and consumes nothing from any provider quota —
 * which matters because this now runs on every login rather than when somebody asks for something.
 *
 * <h2>The three safeguards, and what each prevents</h2>
 * <ul>
 *   <li><b>Debounced.</b> A successful wake is remembered for {@link #WARM_FOR}. Twenty people
 *       signing in for a meeting must not produce twenty wake-up campaigns against one small
 *       instance — that is a self-inflicted denial of service at exactly the busiest moment.
 *   <li><b>Single-flight.</b> One campaign at a time, whatever arrives while it runs. Concurrent
 *       logins collapse into the one attempt already in progress.
 *   <li><b>Bounded.</b> {@link #MAX_ATTEMPTS} with backoff, then it stops. A service that has not
 *       answered in a few minutes is not asleep, and continuing to poll it is how a rate limit gets
 *       made worse rather than waited out.
 * </ul>
 */
@Service
public class AiWarmupService {

    private static final Logger log = LoggerFactory.getLogger(AiWarmupService.class);

    /** How long a successful wake is trusted for. Comfortably inside a free tier's idle timeout. */
    private static final Duration WARM_FOR = Duration.ofMinutes(10);

    /** Backoff between attempts. Front-loaded, then patient — a cold boot loads a model. */
    private static final Duration[] BACKOFF = {
        Duration.ofSeconds(2), Duration.ofSeconds(5), Duration.ofSeconds(10),
        Duration.ofSeconds(20), Duration.ofSeconds(30), Duration.ofSeconds(45),
        Duration.ofSeconds(60),
    };

    /** Roughly three minutes in total across the delays above. */
    private static final int MAX_ATTEMPTS = BACKOFF.length;

    /** Short per-request timeout: this is a liveness poke, not a call whose answer we need. */
    private static final Duration PING_TIMEOUT = Duration.ofSeconds(15);

    private final WebClient web;

    /** When the service was last known good, or null if never in this process's lifetime. */
    private final AtomicReference<Instant> lastWarm = new AtomicReference<>(null);

    /** Whether a campaign is already running — the single-flight guard. */
    private final AtomicBoolean running = new AtomicBoolean(false);

    public AiWarmupService(WebClient.Builder builder,
                           @Value("${ai.service.url:http://localhost:8000}") String baseUrl) {
        // Its own WebClient rather than AiClient's. AiClient is configured for real calls — long
        // timeouts sized for a sleeping service, large buffers for RAG responses — and a liveness
        // poke wants the opposite. Sharing it would also mean a warm-up could occupy a connection
        // that a user's request needs.
        this.web = builder.baseUrl(baseUrl).build();
    }

    /**
     * Somebody signed in. Wake the AI service if it looks cold.
     *
     * <p>{@code @Async}, so the login response does not wait for it — and it deliberately returns
     * nothing and throws nothing. A failed wake must leave signing in completely unaffected; the
     * person is trying to log in, not to use the assistant.
     */
    @Async
    public void warmAfterLogin() {
        Instant warm = lastWarm.get();
        if (warm != null && warm.isAfter(Instant.now().minus(WARM_FOR))) {
            return;   // already known good; say nothing
        }
        if (!running.compareAndSet(false, true)) {
            return;   // a campaign is already under way
        }

        try {
            for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                if (ping()) {
                    lastWarm.set(Instant.now());
                    // INFO on success only, and only when a wake was actually needed — this runs on
                    // every login and must not fill the log with routine noise.
                    log.info("AI service responded on warm-up attempt {} — it is awake.", attempt);
                    return;
                }
                Duration wait = BACKOFF[attempt - 1];
                log.debug("AI service not awake yet (attempt {}/{}); waiting {}s.",
                          attempt, MAX_ATTEMPTS, wait.toSeconds());
                Thread.sleep(wait.toMillis());
            }
            // WARN, not ERROR: nothing is broken for the person who logged in, and the AI features
            // report their own state. This says the pre-warm did not manage it.
            log.warn("AI service did not respond within {} warm-up attempts. It may be paused, "
                     + "rate limited, or AI_SERVICE_URL may not point at it.", MAX_ATTEMPTS);
        } catch (InterruptedException interrupted) {
            // Shutdown. Restore the flag and leave quietly — never swallow the interrupt.
            Thread.currentThread().interrupt();
        } finally {
            running.set(false);
        }
    }

    /** One cheap liveness request. Any answer at all counts; nothing here inspects the body. */
    private boolean ping() {
        try {
            web.get().uri("/health").retrieve().toBodilessEntity()
               .timeout(PING_TIMEOUT).block();
            return true;
        } catch (RuntimeException notYet) {
            return false;
        }
    }

    /** Whether the service was recently confirmed awake — for diagnostics, not for gating. */
    public boolean recentlyWarm() {
        Instant warm = lastWarm.get();
        return warm != null && warm.isAfter(Instant.now().minus(WARM_FOR));
    }
}
