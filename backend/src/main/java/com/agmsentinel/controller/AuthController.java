package com.agmsentinel.controller;

import com.agmsentinel.dto.AuthDtos.*;
import java.util.Map;
import java.security.Principal;
import com.agmsentinel.security.JwtService;
import com.agmsentinel.service.AuthService;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Authentication + MFA.
 *
 * Attendees stay anonymous (a light token, no password). Moderators/admins register with a
 * password and then enroll second factors (PIN, TOTP, passkey); login becomes staged MFA.
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService auth;
    private final JwtService jwt;

    @Value("${spring.security.oauth2.client.registration.google.client-id:}")
    private String googleClientId;
    @Value("${otp.demo-mode:true}")
    private boolean otpDemoMode;

    public AuthController(AuthService auth, JwtService jwt) {
        this.auth = auth;
        this.jwt = jwt;
    }

    /** Tells the SPA which login methods to show (Google button, OTP demo hint). */
    @PostMapping("/login-options")
    public AuthConfig loginOptions() {
        return new AuthConfig(googleClientId != null && !googleClientId.isBlank(), otpDemoMode);
    }

    // ---- attendee (anonymous) ----------------------------------------------
    @PostMapping("/attendee")
    public TokenResponse attendee(@Valid @RequestBody AttendeeRequest req) {
        return new TokenResponse(jwt.issue(req.username(), "ATTENDEE"));
    }

    // ---- register / password login -----------------------------------------
    @PostMapping("/register")
    public LoginResult register(@Valid @RequestBody RegisterRequest req) {
        return auth.register(req);
    }

    @PostMapping("/login")
    public LoginResult login(@Valid @RequestBody LoginRequest req) {
        return auth.login(req);
    }

    @PostMapping("/mfa/verify")
    public TokenResponse verifyMfa(@Valid @RequestBody MfaVerifyRequest req) {
        return auth.verifyMfa(req);
    }

    // ---- passwordless OTP login (email / SMS) -------------------------------
    @PostMapping("/otp/request")
    public OtpRequestResult otpRequest(@Valid @RequestBody OtpRequestReq req) {
        return auth.otpRequest(req.channel(), req.destination());
    }

    @PostMapping("/otp/verify")
    public TokenResponse otpVerify(@Valid @RequestBody OtpVerifyReq req) {
        return auth.otpVerify(req.channel(), req.destination(), req.code());
    }

    /**
     * Renew the current session — the mechanism behind the inactivity timeout.
     *
     * <p>The token's own lifetime is the idle window, so the browser calls this while the user is
     * doing things and simply stops when they are not. A session therefore ends after
     * {@code jwt.ttl-seconds} with no activity, enforced by the server, with no session table to
     * keep or expire.
     *
     * <p>Requires a still-valid token: an expired one cannot be renewed, which is exactly what the
     * timeout means. {@code SecurityConfig} matches this path ahead of the public {@code /api/auth/**}
     * rule so an absent or lapsed token is a 401 here rather than reaching the method.
     */
    /**
     * Change or reset the password for the signed-in account.
     *
     * <p>Under {@code /api/auth/**}, so a session is not enforced by the filter chain — the subject
     * comes from the authenticated principal and the method refuses without one. Identity is
     * re-proved inside {@code changePassword} either way; a session alone is never sufficient to
     * change a password.
     */
    /**
     * Send a reset code to the signed-in account's own email.
     *
     * <p>No destination in the request — see {@code otpRequestForSelf}. Requires a session, so it
     * is declared ahead of the public {@code /api/auth/**} rule in {@code SecurityConfig}.
     */
    @PostMapping("/otp/request-mine")
    public OtpRequestResult otpRequestMine(Principal me) {
        if (me == null || me.getName() == null || me.getName().isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in first.");
        }
        return auth.otpRequestForSelf(me.getName());
    }

    @PostMapping("/change-password")
    public Map<String, Object> changePassword(@Valid @RequestBody ChangePasswordRequest req,
                                              Principal me) {
        if (me == null || me.getName() == null || me.getName().isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,
                    "Sign in before changing your password.");
        }
        auth.changePassword(me.getName(), req.currentPassword(), req.otpChannel(), req.otpCode(),
                            req.newPassword());
        return Map.of("changed", true);
    }

    @PostMapping("/refresh-session")
    public TokenResponse refreshSession(Authentication authn) {
        if (!(authn.getCredentials() instanceof Claims claims)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in again to continue.");
        }
        try {
            return new TokenResponse(jwt.refresh(claims));
        } catch (JwtException ex) {
            // Past the absolute cap, or not an access token. Either way the answer is "sign in".
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, ex.getMessage());
        }
    }

    // ---- enrollment (requires a full access token) --------------------------
    @PostMapping("/enroll/status")
    public MfaStatus status(Authentication authn) {
        return auth.status(authn.getName());
    }

    @PostMapping("/enroll/pin")
    public MfaStatus setPin(Authentication authn, @Valid @RequestBody SetPinRequest req) {
        auth.setPin(authn.getName(), req.pin());
        return auth.status(authn.getName());
    }

    @PostMapping("/enroll/totp/init")
    public TotpInitResult initTotp(Authentication authn) {
        return auth.initTotp(authn.getName());
    }

    @PostMapping("/enroll/totp/enable")
    public MfaStatus enableTotp(Authentication authn, @Valid @RequestBody TotpEnableRequest req) {
        auth.enableTotp(authn.getName(), req.code());
        return auth.status(authn.getName());
    }

    // ---- WebAuthn passkey enrollment (logged-in) ----------------------------
    @PostMapping(value = "/enroll/webauthn/start", produces = "application/json")
    public String webauthnEnrollStart(Authentication authn) {
        return auth.webAuthnEnrollStart(authn.getName());
    }

    @PostMapping("/enroll/webauthn/finish")
    public MfaStatus webauthnEnrollFinish(Authentication authn, @Valid @RequestBody WebAuthnRegFinish req) {
        return auth.webAuthnEnrollFinish(authn.getName(), req.credential().toString());
    }

    // ---- WebAuthn passkey login (public, via MFA challenge) -----------------
    @PostMapping(value = "/mfa/webauthn/start", produces = "application/json")
    public String webauthnLoginStart(@Valid @RequestBody WebAuthnLoginStart req) {
        return auth.webAuthnLoginStart(req.mfaToken());
    }

    @PostMapping("/mfa/webauthn/finish")
    public TokenResponse webauthnLoginFinish(@Valid @RequestBody WebAuthnLoginFinish req) {
        return auth.webAuthnLoginFinish(req.mfaToken(), req.credential().toString());
    }
}
