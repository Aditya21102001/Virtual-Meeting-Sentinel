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

        // DEMO MODE IS THE ONLY THING THAT MAY REVEAL A CODE.
        //
        // This used to read `if (!demoMode && delivery.send(...)) return null;` — so the code was
        // hidden only when delivery SUCCEEDED, and every other path fell through to returning it.
        // With demo mode switched off but no provider configured, `send` returned false and the
        // endpoint went on handing the code back: an operator who had deliberately turned demo mode
        // off still had a public endpoint that would surrender any registered account's sign-in
        // code. The setting appeared to do something and did not.
        //
        // Now the two cases are separate and neither can leak into the other. Out of demo mode,
        // either it was delivered or the request fails — the code is never returned.
        if (!demoMode) {
            if (delivery.send(channel, destination, code)) {
                return null;
            }
            // Delivery failed and revealing the code is not an option. Drop it so a later guess
            // cannot match a code that was generated but never sent.
            store.remove(key(channel, destination));
            log.error("Could not deliver a {} OTP and demo mode is off, so no code was issued. "
                      + "Configure a provider (otp.email.provider / otp.sms.provider) or sign-in "
                      + "by code will not work.", channel);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "We could not send your code right now. Sign in with your password, or try "
                    + "again shortly.");
        }

        // Demo mode: the code is returned to the caller and logged. Usable without a provider, and
        // not safe for production — which is what otp.demo-mode is for.
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
