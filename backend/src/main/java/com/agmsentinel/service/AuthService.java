package com.agmsentinel.service;

import com.agmsentinel.dto.AuthDtos.*;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.JwtService;
import org.springframework.transaction.annotation.Transactional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import dev.samstevens.totp.code.*;
import dev.samstevens.totp.exceptions.QrGenerationException;
import dev.samstevens.totp.qr.QrData;
import dev.samstevens.totp.qr.QrGenerator;
import dev.samstevens.totp.qr.ZxingPngQrGenerator;
import dev.samstevens.totp.secret.DefaultSecretGenerator;
import dev.samstevens.totp.secret.SecretGenerator;
import dev.samstevens.totp.time.SystemTimeProvider;
import dev.samstevens.totp.time.TimeProvider;
import dev.samstevens.totp.util.Utils;
import io.jsonwebtoken.Claims;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.List;

/**
 * Authentication + MFA orchestration.
 *
 * Login is staged: a correct password yields either a full access token (no MFA enrolled)
 * or a short-lived MFA-challenge token. The challenge is exchanged for a full token only
 * after a valid second factor (PIN, TOTP, or — see WebAuthnService — a passkey).
 */
@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private final AppUserRepository users;
    private final PasswordEncoder encoder;
    private final JwtService jwt;
    private final WebAuthnService webAuthn;   // for listing/counting passkeys as an MFA method
    private final OtpService otp;             // passwordless email/SMS OTP login

    private final SecretGenerator secretGenerator = new DefaultSecretGenerator();
    private final CodeVerifier codeVerifier =
            new DefaultCodeVerifier(new DefaultCodeGenerator(), new SystemTimeProvider());
    private final TimeProvider timeProvider = new SystemTimeProvider();

    public AuthService(AppUserRepository users, PasswordEncoder encoder,
                       JwtService jwt, WebAuthnService webAuthn, OtpService otp) {
        this.users = users;
        this.encoder = encoder;
        this.jwt = jwt;
        this.webAuthn = webAuthn;
        this.otp = otp;
    }

    // ---- passwordless OTP login (email / SMS) -------------------------------

    public OtpRequestResult otpRequest(String channel, String destination) {
        String demoCode = otp.request(channel, destination);
        return new OtpRequestResult(true, demoCode);
    }

    public TokenResponse otpVerify(String channel, String destination, String code) {
        AppUser user = otp.verify(channel, destination, code);
        return new TokenResponse(jwt.issue(user.getUsername(), user.getRole(), user.allRoles()));
    }

    /**
     * Send a one-time code to the signed-in account's OWN registered email.
     *
     * <p>Deliberately takes no destination. The ordinary {@code otpRequest} is a sign-in path and
     * must accept an address, because nobody is signed in yet. This one is for a password reset by
     * somebody already in a session — and letting that caller name the destination would mean a
     * session could be used to send a code to any account whose email address the user happened to
     * know, which is the whole attack this flow has to avoid.
     *
     * @return the same result shape as a normal request, so demo mode still surfaces the code
     */
    public OtpRequestResult otpRequestForSelf(String username) {
        AppUser user = users.findByUsername(username).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in again."));
        if (user.getEmail() == null || user.getEmail().isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This account has no email address registered, so a code cannot be sent.");
        }
        // Same wrapping as otpRequest: demoCode is non-null only while demo mode is on, and the
        // caller decides whether showing it is acceptable.
        String demoCode = otp.request("email", user.getEmail());
        return new OtpRequestResult(true, demoCode);
    }

    /**
     * Set a new password, having re-proved who is asking.
     *
     * <h2>Why a session alone is not enough</h2>
     * A signed-in session says somebody authenticated at some point, possibly hours ago on a laptop
     * now sitting unattended. Changing the password from that is how an opportunist locks the real
     * owner out of their own account. So the change is always re-proved, one of two ways:
     *
     * <ul>
     *   <li><b>The current password</b> — for somebody who knows it and simply wants a new one.
     *   <li><b>A fresh one-time code</b> — for somebody who has forgotten it. This is the recovery
     *       path, and it re-proves control of the registered email or phone at the moment of the
     *       change rather than trusting a session that might have been opened any other way.
     * </ul>
     *
     * <p>The OTP branch is what makes this a real reset. Without it, a user who has forgotten their
     * password signs in by code forever and never gets it back — OTP becomes a permanent workaround
     * instead of a recovery.
     *
     * <p>A user with no password at all (signed up through Google) can set one via the OTP branch;
     * there is no current password for them to supply.
     */
    @Transactional
    public void changePassword(String username, String currentPassword,
                               String otpChannel, String otpCode, String newPassword) {
        if (newPassword == null || newPassword.length() < 8) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "A new password must be at least 8 characters.");
        }

        AppUser user = users.findByUsername(username).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in again."));

        boolean proved = false;

        if (otpChannel != null && !otpChannel.isBlank() && otpCode != null && !otpCode.isBlank()) {
            // The code is verified against the destination registered to THIS account, never one
            // supplied by the caller. Taking a destination from the request would let anyone with a
            // session reset any account whose email they could type.
            String destination = "sms".equals(otpChannel) ? user.getPhone() : user.getEmail();
            if (destination == null || destination.isBlank()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "This account has no " + ("sms".equals(otpChannel) ? "mobile number" : "email address")
                        + " registered, so a code cannot be sent to it.");
            }
            otp.verify(otpChannel, destination, otpCode);   // throws on a wrong or expired code
            proved = true;
        } else if (currentPassword != null && !currentPassword.isBlank()
                && user.getPasswordHash() != null
                && encoder.matches(currentPassword, user.getPasswordHash())) {
            proved = true;
        }

        if (!proved) {
            // One message for both failures on purpose: distinguishing "wrong current password"
            // from "wrong code" tells an attacker which half they got right.
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,
                    "Could not verify it is you. Enter your current password, or use a one-time "
                    + "code sent to your registered email.");
        }

        user.setPasswordHash(encoder.encode(newPassword));
        users.save(user);
        log.info("Password changed for {} (verified by {}).", username, otpCode != null ? "one-time code" : "current password");
    }

    /** Find-or-create a user from a verified Google (OAuth2) identity and issue a token. */
    public String oauthLogin(String email, String displayName) {
        AppUser user = users.findByEmail(email).orElseGet(() -> {
            String base = (displayName != null && !displayName.isBlank() ? displayName : email);
            AppUser u = new AppUser(uniqueUsername(base), email, null, "MODERATOR");
            return users.save(u);
        });
        return jwt.issue(user.getUsername(), user.getRole(), user.allRoles());
    }

    private String uniqueUsername(String base) {
        String candidate = base.replaceAll("[^a-zA-Z0-9._+-]", "").toLowerCase();
        if (candidate.length() < 3) candidate = "user-" + candidate;
        while (users.existsByUsername(candidate)) candidate = candidate + (int) (Math.random() * 10);
        return candidate;
    }

    // ---- registration & password login --------------------------------------

    public LoginResult register(RegisterRequest req) {
        String email = Contacts.email(req.email());
        String phone = Contacts.phone(req.phone());
        if (users.existsByUsername(req.username())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Username already taken.");
        }
        if (users.findByEmail(email).isPresent()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Email already registered.");
        }
        if (users.findByPhone(phone).isPresent()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Mobile number already registered.");
        }
        AppUser user = new AppUser(req.username(), email, encoder.encode(req.password()), "MODERATOR");
        user.setPhone(phone);
        users.save(user);
        // Fresh account has no second factor yet → straight to a full token.
        return new LoginResult("AUTHENTICATED", jwt.issue(user.getUsername(), user.getRole(), user.allRoles()), null, null);
    }

    /**
     * Stage 1 of login: verify the password. If the user has no second factor, return a full
     * access token immediately. Otherwise return ONLY a short-lived MFA-challenge token plus the
     * list of factors they can use — no access is granted until stage 2 (verifyMfa) succeeds.
     */
    public LoginResult login(LoginRequest req) {
        // BCrypt.matches re-hashes the input with the stored salt and compares — constant-time,
        // never decrypts. Same generic error whether the user or the password is wrong (avoids
        // leaking which usernames exist).
        AppUser user = users.findByUsername(req.username())
                .filter(u -> encoder.matches(req.password(), u.getPasswordHash()))
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.UNAUTHORIZED, "Invalid username or password."));

        // No PIN/TOTP and no passkey enrolled → single-factor is all they set up → full token.
        if (!user.isMfaEnabled() && !webAuthn.hasCredentials(user)) {
            return new LoginResult("AUTHENTICATED", jwt.issue(user.getUsername(), user.getRole(), user.allRoles()), null, null);
        }
        // MFA enrolled → hand back a challenge token (typ=mfa, no role) + the available methods.
        List<String> methods = enrolledMethods(user);
        return new LoginResult("MFA_REQUIRED", null, jwt.issueMfaChallenge(user.getUsername()), methods);
    }

    /**
     * Stage 2 of login: exchange a valid MFA challenge + a correct PIN/TOTP code for a full
     * access token. (Passkey/WebAuthn assertion is handled separately in webAuthnLoginFinish.)
     */
    public TokenResponse verifyMfa(MfaVerifyRequest req) {
        // Re-derive the user from the challenge token (also proves the token is a valid, unexpired
        // typ=mfa token issued in stage 1) — the client can't just name any user here.
        AppUser user = requireChallengeUser(req.mfaToken());
        boolean ok = switch (req.method().toLowerCase()) {
            // PIN: BCrypt-compare against the stored hash.
            case "pin" -> user.getPinHash() != null && encoder.matches(req.code(), user.getPinHash());
            // TOTP: recompute the expected time-based code from the shared secret and compare.
            case "totp" -> user.isTotpEnabled() && codeVerifier.isValidCode(user.getTotpSecret(), req.code());
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown MFA method.");
        };
        if (!ok) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Incorrect " + req.method() + ".");
        }
        return new TokenResponse(jwt.issue(user.getUsername(), user.getRole(), user.allRoles()));
    }

    // ---- enrollment (requires a full access token; called by the logged-in user) --------

    public void setPin(String username, String pin) {
        AppUser user = require(username);
        user.setPinHash(encoder.encode(pin));
        users.save(user);
    }

    public TotpInitResult initTotp(String username) {
        AppUser user = require(username);
        String secret = secretGenerator.generate();
        user.setTotpSecret(secret);       // stored but not yet enabled until a code is confirmed
        user.setTotpEnabled(false);
        users.save(user);

        QrData data = new QrData.Builder()
                .label(username).secret(secret).issuer("AGM Sentinel")
                .algorithm(HashingAlgorithm.SHA1).digits(6).period(30).build();
        try {
            QrGenerator qr = new ZxingPngQrGenerator();
            String dataUri = Utils.getDataUriForImage(qr.generate(data), qr.getImageMimeType());
            return new TotpInitResult(secret, dataUri, data.getUri());
        } catch (QrGenerationException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not build QR code.");
        }
    }

    public void enableTotp(String username, String code) {
        AppUser user = require(username);
        if (user.getTotpSecret() == null || !codeVerifier.isValidCode(user.getTotpSecret(), code)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Code did not match — try again.");
        }
        user.setTotpEnabled(true);
        users.save(user);
    }

    public MfaStatus status(String username) {
        AppUser user = require(username);
        return new MfaStatus(user.getPinHash() != null, user.isTotpEnabled(), webAuthn.hasCredentials(user));
    }

    // ---- WebAuthn passkey enrollment (logged-in user) -----------------------

    public String webAuthnEnrollStart(String username) {
        return webAuthn.startRegistration(username);
    }

    public MfaStatus webAuthnEnrollFinish(String username, String credentialJson) {
        webAuthn.finishRegistration(username, credentialJson);
        return status(username);
    }

    // ---- WebAuthn passkey login (via MFA challenge) -------------------------

    public String webAuthnLoginStart(String mfaToken) {
        AppUser user = requireChallengeUser(mfaToken);
        return webAuthn.startAssertion(user.getUsername());
    }

    public TokenResponse webAuthnLoginFinish(String mfaToken, String credentialJson) {
        AppUser user = requireChallengeUser(mfaToken);
        if (!webAuthn.finishAssertion(user.getUsername(), credentialJson)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Passkey verification failed.");
        }
        return new TokenResponse(jwt.issue(user.getUsername(), user.getRole(), user.allRoles()));
    }

    // ---- helpers ------------------------------------------------------------

    private List<String> enrolledMethods(AppUser user) {
        List<String> m = new ArrayList<>();
        if (user.getPinHash() != null) m.add("pin");
        if (user.isTotpEnabled()) m.add("totp");
        if (webAuthn.hasCredentials(user)) m.add("webauthn");
        return m;
    }

    private AppUser requireChallengeUser(String mfaToken) {
        Claims claims;
        try {
            claims = jwt.parse(mfaToken);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "MFA session expired — log in again.");
        }
        if (!jwt.isMfaChallenge(claims)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Not an MFA challenge token.");
        }
        return require(claims.getSubject());
    }

    private AppUser require(String username) {
        return users.findByUsername(username)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found."));
    }
}
