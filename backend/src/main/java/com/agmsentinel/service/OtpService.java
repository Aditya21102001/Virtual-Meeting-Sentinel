package com.agmsentinel.service;

import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Passwordless one-time-password login over email or SMS.
 *
 * Delivery is pluggable via {@link OtpDelivery}. With no real email/SMS provider configured
 * the service runs in DEMO MODE: the code is logged and returned in the API response so the
 * flow is fully usable for free (no email account, no paid SMS gateway). Set otp.demo-mode=false
 * and wire a real {@link OtpDelivery} bean to actually send messages.
 */
@Service
public class OtpService {

    private static final Logger log = LoggerFactory.getLogger(OtpService.class);
    private final SecureRandom random = new SecureRandom();

    private record Otp(String code, Instant expiresAt) { }
    private final Map<String, Otp> store = new ConcurrentHashMap<>();

    private final AppUserRepository users;
    private final OtpDelivery delivery;
    private final boolean demoMode;
    private final long ttlSeconds;

    public OtpService(AppUserRepository users, OtpDelivery delivery,
                      @Value("${otp.demo-mode:true}") boolean demoMode,
                      @Value("${otp.ttl-seconds:300}") long ttlSeconds) {
        this.users = users;
        this.delivery = delivery;
        this.demoMode = demoMode;
        this.ttlSeconds = ttlSeconds;
    }

    /**
     * Generate + "send" a code to an email or phone.
     * @return the code itself when in demo mode (so the UI can show it), otherwise null.
     */
    public String request(String channel, String destination) {
        validate(channel, destination);
        lookup(channel, destination);          // must belong to a registered account (else 404)
        String code = String.format("%06d", random.nextInt(1_000_000));
        store.put(key(channel, destination), new Otp(code, Instant.now().plusSeconds(ttlSeconds)));

        // Try real delivery (e.g. SMS via TextBelt/Fast2SMS) unless demo mode is forced. If the
        // message really goes out, the code is hidden. Otherwise (no provider, send failed, or
        // demo mode) fall back to showing the code in the API response.
        if (!demoMode && delivery.send(channel, destination, code)) {
            return null;
        }
        log.info("[OTP demo] {} code for {} = {}", channel, destination, code);
        return code;
    }

    /** Verify a code and return the registered user it belongs to. */
    public AppUser verify(String channel, String destination, String code) {
        validate(channel, destination);
        Otp otp = store.get(key(channel, destination));
        if (otp == null || Instant.now().isAfter(otp.expiresAt())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Code expired — request a new one.");
        }
        if (!otp.code().equals(code)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Incorrect code.");
        }
        store.remove(key(channel, destination));
        return lookup(channel, destination);
    }

    /** Find the registered account for an email/phone, or 404 (OTP is not a sign-up path). */
    private AppUser lookup(String channel, String destination) {
        if ("email".equals(channel)) {
            return users.findByEmail(Contacts.email(destination)).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.NOT_FOUND,
                            "No account is registered with this email. Please register first."));
        }
        return users.findByPhone(Contacts.phone(destination)).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "No account is registered with this mobile number. Please register first."));
    }

    private void validate(String channel, String destination) {
        if (!"email".equals(channel) && !"sms".equals(channel)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "channel must be 'email' or 'sms'.");
        }
        if (destination == null || destination.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Destination is required.");
        }
    }

    private String key(String channel, String destination) {
        String d = "email".equals(channel) ? Contacts.email(destination) : Contacts.phone(destination);
        return channel + ":" + d;
    }
}
