package com.agmsentinel.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.*;
import java.util.List;

/** Request/response records for authentication + MFA. */
public final class AuthDtos {
    private AuthDtos() { }

    // ---- WebAuthn (passkey / biometric) -------------------------------------
    /** Finish enrolling a passkey (browser's PublicKeyCredential as JSON). */
    public record WebAuthnRegFinish(@NotNull JsonNode credential) { }
    /** Begin a passkey login using the MFA challenge token. */
    public record WebAuthnLoginStart(@NotBlank String mfaToken) { }
    /** Finish a passkey login. */
    public record WebAuthnLoginFinish(@NotBlank String mfaToken, @NotNull JsonNode credential) { }

    // ---- attendee (anonymous, light) ----------------------------------------
    public record AttendeeRequest(@NotBlank String username) { }

    // ---- register / password login (moderator/admin) ------------------------
    public record RegisterRequest(
            @NotBlank(message = "Username is required")
            @Size(min = 3, max = 40, message = "Username must be 3–40 characters") String username,
            @NotBlank(message = "Email is required")
            @Email(message = "Enter a valid email address") String email,
            @NotBlank(message = "Mobile number is required")
            @Pattern(regexp = "^[+]?[0-9 ()-]{7,20}$", message = "Enter a valid mobile number") String phone,
            @NotBlank(message = "Password is required")
            @Size(min = 8, max = 100, message = "Password must be at least 8 characters") String password) { }

    public record LoginRequest(@NotBlank String username, @NotBlank String password) { }

    /**
     * Result of a password login.
     *   status = AUTHENTICATED → `token` is a full access JWT (no MFA enrolled)
     *   status = MFA_REQUIRED  → `mfaToken` authorizes the 2nd-factor step; `methods` lists options
     */
    public record LoginResult(
            String status,
            String token,
            String mfaToken,
            List<String> methods) { }

    // ---- MFA verify ---------------------------------------------------------
    public record MfaVerifyRequest(
            @NotBlank String mfaToken,
            @NotBlank String method,      // "pin" | "totp"
            @NotBlank String code) { }

    // ---- enrollment ---------------------------------------------------------
    public record SetPinRequest(@NotBlank @Pattern(regexp = "\\d{4,8}") String pin) { }

    public record TotpInitResult(String secret, String qrDataUri, String otpauthUri) { }

    public record TotpEnableRequest(@NotBlank String code) { }

    public record TokenResponse(String token) { }

    public record MfaStatus(boolean pin, boolean totp, boolean webauthn) { }

    // ---- passwordless OTP login (email / SMS) -------------------------------
    public record OtpRequestReq(
            @NotBlank String channel,          // "email" | "sms"
            @NotBlank String destination) { }  // the email address or phone number

    /** demoCode is non-null only in demo mode (no real email/SMS provider configured). */
    public record OtpRequestResult(boolean sent, String demoCode) { }

    public record OtpVerifyReq(
            @NotBlank String channel,
            @NotBlank String destination,
            @NotBlank String code) { }

    // ---- public client config (which login methods to show) -----------------
    public record AuthConfig(boolean googleEnabled, boolean otpDemoMode) { }
}
