package com.agmsentinel.service;

import com.agmsentinel.dto.AuthDtos.*;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.JwtService;
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
        return new TokenResponse(jwt.issue(user.getUsername(), user.getRole()));
    }

    /** Find-or-create a user from a verified Google (OAuth2) identity and issue a token. */
    public String oauthLogin(String email, String displayName) {
        AppUser user = users.findByEmail(email).orElseGet(() -> {
            String base = (displayName != null && !displayName.isBlank() ? displayName : email);
            AppUser u = new AppUser(uniqueUsername(base), email, null, "MODERATOR");
            return users.save(u);
        });
        return jwt.issue(user.getUsername(), user.getRole());
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
        return new LoginResult("AUTHENTICATED", jwt.issue(user.getUsername(), user.getRole()), null, null);
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
            return new LoginResult("AUTHENTICATED", jwt.issue(user.getUsername(), user.getRole()), null, null);
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
        return new TokenResponse(jwt.issue(user.getUsername(), user.getRole()));
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
        return new TokenResponse(jwt.issue(user.getUsername(), user.getRole()));
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
