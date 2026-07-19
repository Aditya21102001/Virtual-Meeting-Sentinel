package com.agmsentinel.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Delivers OTP codes. Real SMS is sent when an SMS provider is configured
 * (otp.sms.provider + otp.sms.api-key). Email is intentionally not wired right now.
 *
 * If the channel has no configured provider, {@link #send} returns {@code false} and the caller
 * (OtpService) falls back to demo mode (showing the code on screen).
 *
 * Free-ish SMS providers (no credit card):
 *   - textbelt : global; the shared key "textbelt" grants 1 free SMS/day (great for a demo).
 *   - fast2sms : India; free signup, wallet top-up via UPI (no card). Uses the OTP route.
 */
@Component
public class OtpDelivery {

    private static final Logger log = LoggerFactory.getLogger(OtpDelivery.class);
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10)).build();

    private final String provider;   // "textbelt" | "fast2sms" | "" (none → demo)
    private final String apiKey;

    public OtpDelivery(@Value("${otp.sms.provider:}") String provider,
                       @Value("${otp.sms.api-key:}") String apiKey) {
        this.provider = provider == null ? "" : provider.trim().toLowerCase();
        this.apiKey = apiKey == null ? "" : apiKey.trim();
    }

    /** @return true only if the code was really delivered (so the caller must NOT reveal it). */
    public boolean send(String channel, String destination, String code) {
        // Only SMS is wired for real delivery, and only when a provider + key are configured.
        if (!"sms".equals(channel) || provider.isBlank() || apiKey.isBlank()) {
            return false;
        }
        try {
            return switch (provider) {
                case "textbelt" -> textbelt(destination, code);
                case "fast2sms" -> fast2sms(destination, code);
                default -> false;
            };
        } catch (Exception e) {
            log.warn("SMS send via {} failed: {}", provider, e.getMessage());
            return false;   // fall back to demo rather than blocking the user
        }
    }

    /** TextBelt: POST phone/message/key; the shared "textbelt" key allows 1 free SMS/day. */
    private boolean textbelt(String phone, String code) throws Exception {
        String message = "Your VIRTUAL MEETING Sentinel code is " + code + ". It expires in 5 minutes.";
        String body = "phone=" + enc(phone) + "&message=" + enc(message) + "&key=" + enc(apiKey);
        HttpResponse<String> resp = post("https://textbelt.com/text", null, body);
        boolean ok = resp.statusCode() == 200 && resp.body().contains("\"success\":true");
        logResult("textbelt", phone, ok, resp);
        return ok;
    }

    /** Fast2SMS OTP route (India). Requires a 10-digit number, so strip country code / symbols. */
    private boolean fast2sms(String phone, String code) throws Exception {
        String tenDigits = phone.replaceAll("[^0-9]", "");
        if (tenDigits.length() > 10) tenDigits = tenDigits.substring(tenDigits.length() - 10);
        String body = "route=otp&variables_values=" + enc(code) + "&numbers=" + enc(tenDigits) + "&flash=0";
        HttpResponse<String> resp = post("https://www.fast2sms.com/dev/bulkV2", apiKey, body);
        boolean ok = resp.statusCode() == 200 && resp.body().contains("\"return\":true");
        logResult("fast2sms", phone, ok, resp);
        return ok;
    }

    private HttpResponse<String> post(String url, String authHeader, String formBody) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .timeout(Duration.ofSeconds(15))
                .POST(HttpRequest.BodyPublishers.ofString(formBody));
        if (authHeader != null) b.header("authorization", authHeader);   // Fast2SMS uses this
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private void logResult(String provider, String phone, boolean ok, HttpResponse<String> resp) {
        if (ok) log.info("Sent OTP SMS to {} via {}", phone, provider);
        else log.warn("{} SMS failed (HTTP {}): {}", provider, resp.statusCode(), resp.body());
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }
}
