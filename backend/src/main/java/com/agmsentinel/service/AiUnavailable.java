package com.agmsentinel.service;

import org.springframework.web.reactive.function.client.WebClientRequestException;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.concurrent.TimeoutException;

/**
 * Why the AI service could not be reached, in words an operator can act on.
 *
 * <h2>Why this exists</h2>
 * Every failure used to produce one message: <em>"It sleeps when idle and takes up to a minute to
 * wake — try again shortly."</em> That is correct for a cold start and actively misleading for
 * everything else, and it cost real time twice in one day:
 *
 * <ul>
 *   <li>A 429 was reported as sleep. Waiting cannot clear a rate limit, so the advice sent somebody
 *       away to do the one thing that would not help.
 *   <li>A 404 was reported as sleep. The endpoint was genuinely absent from the deployed service —
 *       eight of them were — and "try again shortly" hid a deployment that had drifted for weeks.
 * </ul>
 *
 * <p>The distinction that matters is not the status code but <b>what the reader should do next</b>:
 * wait, look at a quota, or look at what is deployed. Each branch below answers exactly that.
 */
public final class AiUnavailable {

    private AiUnavailable() { }

    /**
     * A classified failure: what to say, and whether retrying can possibly help.
     *
     * <p>{@code retryable} is the half a client can act on. The admin screen retries a 503 thirteen
     * times over five minutes, which is right for a cold start and actively harmful for a rate
     * limit — it adds load to the service that is already refusing, and hides the real cause behind
     * five minutes of reassuring spinner. The message alone could not fix that, because a message is
     * for a human and the retry decision is made by code.
     */
    public record Diagnosis(String message, boolean retryable) { }

    /** What to tell the caller, given whatever the WebClient threw. */
    public static String explain(Throwable failure) {
        return diagnose(failure).message();
    }

    /** The full classification: message plus whether waiting could change the answer. */
    public static Diagnosis diagnose(Throwable failure) {
        Throwable cause = unwrap(failure);

        if (cause instanceof WebClientResponseException http) {
            int status = http.getStatusCode().value();

            // 429. Not sleep — an immediate refusal. It arrives in milliseconds, where a cold start
            // takes tens of seconds, and no amount of waiting clears it on its own.
            if (status == 429) {
                // NOT retryable. Retrying is what makes a rate limit worse.
                return new Diagnosis(
                        "The AI service is rate limited (HTTP 429), so this is not a cold start — "
                      + "waiting will not clear it. Check the model provider's quota (GROQ_API_KEY), "
                      + "and whether the hosting platform is throttling the service.", false);
            }

            // 404. The service answered, so it is awake; it simply does not have this endpoint.
            // Almost always a deployed copy that has fallen behind the source.
            if (status == 404) {
                // NOT retryable. The endpoint will not appear by waiting for it.
                return new Diagnosis(
                        "The AI service is running but does not have the endpoint this needs "
                      + "(HTTP 404). The deployed copy is behind the source — re-deploy it from "
                      + "ai-service/ (see .deploy/hf-space/sync-from-ai-service.sh).", false);
            }

            // 401/403. Reached, refused. A key or an access setting, never a wait.
            if (status == 401 || status == 403) {
                return new Diagnosis(
                        "The AI service refused the request (HTTP " + status + "). Its API key or "
                      + "access settings need attention; retrying will not change the answer.", false);
            }

            // 502/503/504 from the platform in front of the service is the genuine "waking" case.
            if (status == 502 || status == 503 || status == 504) {
                // The genuine cold start, and the only HTTP case worth waiting out.
                return new Diagnosis(
                        "The AI service is starting up (HTTP " + status + "). It sleeps when idle "
                      + "and takes up to a minute to wake — try again shortly.", true);
            }

            // Any other 5xx is the service itself failing, which is a bug rather than a wait.
            if (status >= 500) {
                return new Diagnosis(
                        "The AI service returned an error (HTTP " + status + "). It is reachable, so "
                      + "this is a fault in the service rather than a cold start — check its logs.",
                        false);
            }
            return new Diagnosis(
                    "The AI service rejected the request (HTTP " + status + ").", false);
        }

        // No HTTP response at all: connection refused, DNS, or the socket closed mid-flight. This
        // is what a container that is genuinely down or still booting produces.
        if (cause instanceof WebClientRequestException || cause instanceof TimeoutException) {
            // No response at all is what a booting container produces, so this one waits.
            return new Diagnosis(
                    "The AI service could not be reached at all. It sleeps when idle and takes up "
                  + "to a minute to wake — try again shortly. If it persists, check that the "
                  + "service is running and that AI_SERVICE_URL points at it.", true);
        }

        // Unknown shape. Allowed one round of retries rather than none: an unrecognised transient
        // failure is more likely than an unrecognised permanent one, and the cap bounds the cost.
        return new Diagnosis(
                "The AI service is not responding (" + cause.getClass().getSimpleName() + ").", true);
    }

    /**
     * The most specific cause available.
     *
     * <p>WebClient wraps failures, and reactive operators wrap them again, so the interesting
     * exception is usually not the one thrown at the call site. Walking to the deepest cause that is
     * still one of the types above is what makes the classification above fire at all — without it
     * everything falls through to the generic branch, which is the behaviour being fixed.
     */
    private static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        Throwable best = failure;
        int guard = 0;   // cyclic cause chains exist; never loop forever inside an error path
        while (current != null && guard++ < 10) {
            if (current instanceof WebClientResponseException
                    || current instanceof WebClientRequestException
                    || current instanceof TimeoutException) {
                best = current;
            }
            current = current.getCause() == current ? null : current.getCause();
        }
        return best;
    }
}
