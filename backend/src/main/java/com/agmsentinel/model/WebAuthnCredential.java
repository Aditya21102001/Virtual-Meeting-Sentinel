package com.agmsentinel.model;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * A registered WebAuthn/FIDO2 passkey (biometric credential). One user may have several
 * (laptop fingerprint, phone, security key). We store the public key + signature counter;
 * the private key and biometric never leave the user's device.
 */
@Entity
@Table(name = "webauthn_credentials")
public class WebAuthnCredential {

    @Id
    @GeneratedValue
    private UUID id;

    @ManyToOne(optional = false, fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private AppUser user;

    /** Base64url credential id (handle) returned by the authenticator. */
    @Column(name = "credential_id", nullable = false, unique = true, length = 1024)
    private String credentialId;

    /** Base64url COSE public key used to verify future assertions. */
    @Column(name = "public_key_cose", nullable = false, length = 4096)
    private String publicKeyCose;

    /** Signature counter for clone-detection. */
    @Column(name = "sign_count", nullable = false)
    private long signCount;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    protected WebAuthnCredential() { }

    public WebAuthnCredential(AppUser user, String credentialId, String publicKeyCose, long signCount) {
        this.user = user;
        this.credentialId = credentialId;
        this.publicKeyCose = publicKeyCose;
        this.signCount = signCount;
    }

    public UUID getId() { return id; }
    public AppUser getUser() { return user; }
    public String getCredentialId() { return credentialId; }
    public String getPublicKeyCose() { return publicKeyCose; }
    public long getSignCount() { return signCount; }
    public void setSignCount(long signCount) { this.signCount = signCount; }
}
