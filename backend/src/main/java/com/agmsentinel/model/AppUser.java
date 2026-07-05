package com.agmsentinel.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * A registered user (moderator/admin). Attendees remain anonymous, so they have no row here.
 * Holds the credentials for every supported factor:
 *   - password (BCrypt)                          — something you know
 *   - PIN      (BCrypt)                           — something you know (2nd)
 *   - TOTP secret                                — something you have (authenticator app)
 *   - WebAuthn credentials (separate table)      — something you are (biometric passkey)
 */
@Entity
@Table(name = "app_users", uniqueConstraints = @UniqueConstraint(columnNames = "username"))
public class AppUser {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false, unique = true)
    private String username;

    @Column
    private String email;

    @Column
    private String phone;

    // Nullable: users who sign in only via Google/OTP have no local password.
    @Column(name = "password_hash")
    private String passwordHash;

    @Column(nullable = false)
    private String role = "MODERATOR";   // MODERATOR or ADMIN

    // ---- second factors (all optional; enrolled after signup) ----------------
    @Column(name = "pin_hash")
    private String pinHash;

    @Column(name = "totp_secret")
    private String totpSecret;

    @Column(name = "totp_enabled", nullable = false)
    private boolean totpEnabled = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected AppUser() { }

    public AppUser(String username, String email, String passwordHash, String role) {
        this.username = username;
        this.email = email;
        this.passwordHash = passwordHash;
        this.role = role;
    }

    /** True once the user has enrolled at least one second factor → MFA is enforced at login. */
    public boolean isMfaEnabled() {
        return pinHash != null || totpEnabled;
    }

    public UUID getId() { return id; }
    public String getUsername() { return username; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPhone() { return phone; }
    public void setPhone(String phone) { this.phone = phone; }
    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }
    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }
    public String getPinHash() { return pinHash; }
    public void setPinHash(String pinHash) { this.pinHash = pinHash; }
    public String getTotpSecret() { return totpSecret; }
    public void setTotpSecret(String totpSecret) { this.totpSecret = totpSecret; }
    public boolean isTotpEnabled() { return totpEnabled; }
    public void setTotpEnabled(boolean totpEnabled) { this.totpEnabled = totpEnabled; }
    public Instant getCreatedAt() { return createdAt; }
}
