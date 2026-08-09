package com.agmsentinel.service;

import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.repository.WebAuthnCredentialRepository;
import com.agmsentinel.model.WebAuthnCredential;
import com.agmsentinel.security.JpaCredentialRepository;
import com.yubico.webauthn.*;
import com.yubico.webauthn.data.*;
import com.yubico.webauthn.exception.AssertionFailedException;
import com.yubico.webauthn.exception.RegistrationFailedException;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * WebAuthn/FIDO2 passkey (biometric) ceremonies via the Yubico library.
 *
 * Registration: browser creates a key pair in the device authenticator (Windows Hello / Touch
 * ID); we store the public key. Assertion (login): the device signs a challenge with the
 * private key after a local biometric check; we verify the signature. The biometric and the
 * private key never leave the device.
 *
 * rpId/origin MUST match the FRONTEND domain (where navigator.credentials runs), configured via
 * webauthn.* properties (localhost for dev; the Vercel domain in prod).
 */
@Service
public class WebAuthnService {

    /**
     * Passkey ceremonies are logged as security events.
     *
     * <p>Registration adds a new way into an account and failed assertion is what an attack looks
     * like from here, so both are recorded. What is never recorded is the credential ID or the
     * public key — those identify the authenticator, and a log file is the wrong place for them.
     */
    private static final Logger log = LoggerFactory.getLogger(WebAuthnService.class);

    private final AppUserRepository users;
    private final WebAuthnCredentialRepository creds;
    private final JpaCredentialRepository credentialRepository;

    private final String rpId;
    private final String rpName;
    private final Set<String> origins;

    private RelyingParty rp;

    // Pending ceremonies keyed by username (single-instance free tier → in-memory is fine).
    private final Map<String, PublicKeyCredentialCreationOptions> pendingReg = new ConcurrentHashMap<>();
    private final Map<String, AssertionRequest> pendingAssert = new ConcurrentHashMap<>();

    public WebAuthnService(AppUserRepository users, WebAuthnCredentialRepository creds,
                           JpaCredentialRepository credentialRepository,
                           @Value("${webauthn.rp-id:localhost}") String rpId,
                           @Value("${webauthn.rp-name:AGM Sentinel}") String rpName,
                           @Value("${webauthn.origins:http://localhost:4200}") String origins) {
        this.users = users;
        this.creds = creds;
        this.credentialRepository = credentialRepository;
        this.rpId = rpId;
        this.rpName = rpName;
        this.origins = Arrays.stream(origins.split(",")).map(String::trim)
                .filter(s -> !s.isEmpty()).collect(Collectors.toSet());
    }

    @PostConstruct
    void init() {
        this.rp = RelyingParty.builder()
                .identity(RelyingPartyIdentity.builder().id(rpId).name(rpName).build())
                .credentialRepository(credentialRepository)
                .origins(origins)
                .build();
    }

    public boolean hasCredentials(AppUser user) {
        return creds.countByUser(user) > 0;
    }

    // ---- registration (enroll a passkey; user is already logged in) ---------

    public String startRegistration(String username) {
        AppUser user = require(username);
        UserIdentity identity = UserIdentity.builder()
                .name(username)
                .displayName(username)
                .id(JpaCredentialRepository.uuidToHandle(user.getId()))
                .build();
        PublicKeyCredentialCreationOptions options = rp.startRegistration(
                StartRegistrationOptions.builder()
                        .user(identity)
                        .authenticatorSelection(AuthenticatorSelectionCriteria.builder()
                                .userVerification(UserVerificationRequirement.PREFERRED)
                                .build())
                        .build());
        pendingReg.put(username, options);
        try {
            return options.toCredentialsCreateJson();
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "WebAuthn start failed.");
        }
    }

    public void finishRegistration(String username, String credentialJson) {
        AppUser user = require(username);
        PublicKeyCredentialCreationOptions request = pendingReg.remove(username);
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No pending registration.");
        }
        try {
            PublicKeyCredential<AuthenticatorAttestationResponse, ClientRegistrationExtensionOutputs> pkc =
                    PublicKeyCredential.parseRegistrationResponseJson(credentialJson);
            RegistrationResult result = rp.finishRegistration(FinishRegistrationOptions.builder()
                    .request(request).response(pkc).build());
            creds.save(new WebAuthnCredential(
                    user,
                    result.getKeyId().getId().getBase64Url(),
                    result.getPublicKeyCose().getBase64Url(),
                    result.getSignatureCount()));
            // A new passkey is a new way into the account — worth recording for the same reason a
            // role change is. The credential ID is deliberately not logged: it identifies the
            // authenticator, and a log file is not the place for it.
            log.info("Passkey registered for {} (now has {} credential(s)).",
                     username, creds.countByUser(user));
        } catch (RegistrationFailedException | java.io.IOException e) {
            log.warn("Passkey registration failed for {}: {}", username, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Passkey registration failed: " + e.getMessage());
        }
    }

    // ---- assertion (login with a passkey) -----------------------------------

    public String startAssertion(String username) {
        require(username);
        AssertionRequest request = rp.startAssertion(
                StartAssertionOptions.builder().username(username).build());
        pendingAssert.put(username, request);
        try {
            return request.toCredentialsGetJson();
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "WebAuthn start failed.");
        }
    }

    public boolean finishAssertion(String username, String credentialJson) {
        AssertionRequest request = pendingAssert.remove(username);
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No pending assertion.");
        }
        try {
            PublicKeyCredential<AuthenticatorAssertionResponse, ClientAssertionExtensionOutputs> pkc =
                    PublicKeyCredential.parseAssertionResponseJson(credentialJson);
            AssertionResult result = rp.finishAssertion(FinishAssertionOptions.builder()
                    .request(request).response(pkc).build());
            if (result.isSuccess()) {
                // Persist the new signature counter for clone detection.
                creds.findByCredentialId(result.getCredential().getCredentialId().getBase64Url())
                        .ifPresent(c -> { c.setSignCount(result.getSignatureCount()); creds.save(c); });
                log.debug("Passkey assertion succeeded for {}.", username);
                return true;
            }
            // The library verified the signature and said no. Distinct from the exception below and
            // worth its own line: this is the shape a cloned or tampered authenticator takes.
            log.warn("Passkey assertion rejected for {} — the signature did not verify.", username);
            return false;
        } catch (AssertionFailedException | java.io.IOException e) {
            // Previously returned false in silence. A failed passkey login is precisely the event
            // somebody investigating an account would look for, and there was nothing to find.
            log.warn("Passkey assertion failed for {}: {}", username, e.getMessage());
            return false;
        }
    }

    private AppUser require(String username) {
        return users.findByUsername(username)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found."));
    }
}
