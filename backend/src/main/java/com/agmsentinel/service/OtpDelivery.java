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
 * Delivers OTP codes over SMS or email, when a provider is configured for that channel.
 *
 * <h2>Why email matters more than SMS here</h2>
 * Registration requires an email address, and there is no password-reset flow — so a one-time
 * code to that address IS the recovery path for a forgotten password. Until a provider is
 * configured the caller falls back to DEMO MODE and returns the code in the API response, which
 * is fine for a demo and an account-takeover hole in production.
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

    /** "brevo", or empty for no email delivery — the caller then falls back to demo mode. */
    private final String emailProvider;
    private final String emailApiKey;
    /**
     * The From address. Must be one the provider has VERIFIED, or every send is rejected. That
     * verification step is the one people skip, so its absence is reported explicitly below.
     */
    private final String emailFrom;
    private final String emailFromName;

    public OtpDelivery(@Value("${otp.sms.provider:}") String provider,
                       @Value("${otp.sms.api-key:}") String apiKey,
                       @Value("${otp.email.provider:}") String emailProvider,
                       @Value("${otp.email.api-key:}") String emailApiKey,
                       @Value("${otp.email.from:}") String emailFrom,
                       @Value("${otp.email.from-name:VIRTUAL MEETING Sentinel}") String emailFromName) {
        this.provider = provider == null ? "" : provider.trim().toLowerCase();
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.emailProvider = emailProvider == null ? "" : emailProvider.trim().toLowerCase();
        this.emailApiKey = emailApiKey == null ? "" : emailApiKey.trim();
        this.emailFrom = emailFrom == null ? "" : emailFrom.trim();
        this.emailFromName = emailFromName == null || emailFromName.isBlank()
                ? "VIRTUAL MEETING Sentinel" : emailFromName.trim();
    }

    /** @return true only if the code was really delivered (so the caller must NOT reveal it). */
    public boolean send(String channel, String destination, String code) {
        if ("email".equals(channel)) return sendEmail(destination, code);
        if ("sms".equals(channel)) return sendSms(destination, code);
        return false;
    }

    private boolean sendSms(String destination, String code) {
        if (provider.isBlank() || apiKey.isBlank()) return false;
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

    /**
     * Send the code by email.
     *
     * <p>Returns false rather than throwing when nothing is configured or the send fails, so a
     * provider outage degrades to the caller's fallback instead of an error in the user's face.
     * Whether that fallback is safe is {@code otp.demo-mode}'s decision, not this class's.
     */
    private boolean sendEmail(String destination, String code) {
        if (emailProvider.isBlank() || emailApiKey.isBlank()) return false;
        if (emailFrom.isBlank()) {
            // Its own message, because the key can be perfectly valid and every send still fail for
            // want of a verified sender — and the provider's own error for that is not obvious.
            log.warn("otp.email.from is not set. Brevo rejects any send without a verified sender "
                     + "address; set OTP_EMAIL_FROM to the address you verified.");
            return false;
        }
        try {
            if ("brevo".equals(emailProvider)) return brevo(destination, code);
            log.warn("Unknown email provider '{}' — no email sent.", emailProvider);
            return false;
        } catch (Exception e) {
            log.warn("Email send via {} failed: {}", emailProvider, e.getMessage());
            return false;
        }
    }

    /**
     * Brevo's transactional email API — 300/day free, permanently, no card.
     *
     * <p>HTTP rather than SMTP deliberately: no mail dependency, and no outbound SMTP port for the
     * host to block. 201 Created is success; anything else is logged WITH the response body,
     * because Brevo's rejections name the actual problem (unverified sender, bad key) and that
     * sentence is worth far more than "email failed".
     */
    private boolean brevo(String email, String code) throws Exception {
        String text = "Your VIRTUAL MEETING Sentinel sign-in code is " + code + ".\\n\\n"
                + "It expires in 5 minutes. If you did not ask for it you can ignore this email.";

        String json = "{\"sender\":{\"name\":\"" + esc(emailFromName)
                + "\",\"email\":\"" + esc(emailFrom) + "\"},"
                + "\"to\":[{\"email\":\"" + esc(email) + "\"}],"
                + "\"subject\":\"Your sign-in code: " + esc(code) + "\","
                + "\"textContent\":\"" + esc(text) + "\"}";

        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.brevo.com/v3/smtp/email"))
                .header("api-key", emailApiKey)
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .timeout(Duration.ofSeconds(15))
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> resp = http.send(request, HttpResponse.BodyHandlers.ofString());
        boolean ok = resp.statusCode() == 201;
        if (ok) {
            // Masked: a log recording who signed in and when is a tracking record nobody asked for.
            log.info("Sent OTP email to {} via brevo", maskEmail(email));
        } else {
            log.warn("brevo email failed (HTTP {}): {}", resp.statusCode(), resp.body());
        }
        return ok;
    }

    /** "ad***@gmail.com" — identifies the account in a log without recording the address. */
    private static String maskEmail(String email) {
        int at = email.indexOf('@');
        if (at <= 2) return "***" + (at < 0 ? "" : email.substring(at));
        return email.substring(0, 2) + "***" + email.substring(at);
    }

    /**
     * Escape a value for the JSON above.
     *
     * <p>Hand-rolled rather than pulling in a mapper for four fields, but a real escape rather than
     * a hope: a display name containing a quote would otherwise produce malformed JSON and a send
     * that fails for a reason nobody would guess from the error.
     */
    private static String esc(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        return out.toString();
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
