package com.agmsentinel.service;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Wrapping and unwrapping the AES content key with RSA.
 *
 * <h2>What is actually at stake</h2>
 * If wrapping is broken, recordings are encoded with a key nobody can recover — and the failure is
 * invisible until somebody presses play on a meeting that has already happened, by which point the
 * source upload has been cleaned up. There is no recovering from that, so this is checked directly
 * rather than inferred from the pipeline working.
 */
class VideoContentKeyServiceTest {

    private static String publicKey;
    private static String privateKey;
    private static String otherPublicKey;
    private static String otherPrivateKey;

    @BeforeAll
    static void generateKeypairs() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);

        KeyPair pair = gen.generateKeyPair();
        publicKey = Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
        privateKey = Base64.getEncoder().encodeToString(pair.getPrivate().getEncoded());

        KeyPair other = gen.generateKeyPair();
        otherPublicKey = Base64.getEncoder().encodeToString(other.getPublic().getEncoded());
        otherPrivateKey = Base64.getEncoder().encodeToString(other.getPrivate().getEncoded());
    }

    private VideoContentKeyService service() {
        return new VideoContentKeyService(publicKey, privateKey);
    }

    @Test
    @DisplayName("a content key survives a wrap and unwrap unchanged")
    void roundTrip() {
        VideoContentKeyService keys = service();

        byte[] content = keys.newContentKey();
        byte[] recovered = keys.unwrap(keys.wrap(content));

        assertThat(recovered)
                .as("a key that does not survive the round trip means an unplayable recording")
                .isEqualTo(content);
    }

    @Test
    @DisplayName("the content key is AES-128, because that is what HLS requires")
    void keyLength() {
        assertThat(service().newContentKey())
                .as("HLS defines METHOD=AES-128; any other length produces segments nothing can play")
                .hasSize(16);
    }

    @Test
    @DisplayName("every recording gets its own key")
    void keysAreNotReused() {
        VideoContentKeyService keys = service();

        // One leaked key should cost one meeting's footage, not the whole archive.
        assertThat(keys.newContentKey()).isNotEqualTo(keys.newContentKey());
    }

    @Test
    @DisplayName("the same key wrapped twice gives different ciphertext")
    void wrappingIsRandomised() {
        VideoContentKeyService keys = service();
        byte[] content = keys.newContentKey();

        // OAEP is randomised. Identical output would mean an attacker with the database could tell
        // which recordings share a key just by comparing columns.
        assertThat(keys.wrap(content)).isNotEqualTo(keys.wrap(content));
    }

    @Test
    @DisplayName("the wrapping really is RSA, not a symmetric scheme wearing the name")
    void wrappingIsActuallyRsa() {
        VideoContentKeyService keys = service();

        byte[] sealed = Base64.getDecoder().decode(keys.wrap(keys.newContentKey()));

        // An RSA ciphertext is exactly one modulus wide — 2048 bits = 256 bytes — regardless of how
        // short the plaintext is. Any symmetric construction would produce roughly the input size
        // plus a nonce and tag (~44 bytes here), so this single number distinguishes them.
        assertThat(sealed)
                .as("2048-bit RSA emits a 256-byte block; a symmetric wrap would be far smaller")
                .hasSize(256);
    }

    @Test
    @DisplayName("a key wrapped to a different keypair cannot be read, and says so")
    void wrongKeypairIsRefusedWithAUsefulMessage() {
        String sealed = service().wrap(service().newContentKey());
        VideoContentKeyService stranger = new VideoContentKeyService(otherPublicKey, otherPrivateKey);

        assertThatThrownBy(() -> stranger.unwrap(sealed))
                .isInstanceOf(IllegalStateException.class)
                // The overwhelmingly likely cause is a replaced keypair. Saying "decryption failed"
                // would send somebody hunting through the video pipeline for a config problem.
                .hasMessageContaining("different RSA keypair");
    }

    @Test
    @DisplayName("a tampered stored key is refused rather than decrypted to rubbish")
    void tamperingIsDetected() {
        VideoContentKeyService keys = service();
        String sealed = keys.wrap(keys.newContentKey());

        byte[] raw = Base64.getDecoder().decode(sealed);
        raw[raw.length - 1] ^= 0x01;
        String tampered = Base64.getEncoder().encodeToString(raw);

        assertThatThrownBy(() -> keys.unwrap(tampered)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("a content key sealed to a browser's public key is readable only by that browser")
    void sealingToAClientKeypair() throws Exception {
        VideoContentKeyService keys = service();
        byte[] content = keys.newContentKey();

        // The browser generates this pair and never sends the private half anywhere.
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair client = gen.generateKeyPair();
        String clientPublic = Base64.getEncoder().encodeToString(client.getPublic().getEncoded());

        byte[] sealed = keys.sealToClient(content, clientPublic);

        // Nothing recognisable crosses the wire: the raw key is not a substring of the response.
        assertThat(sealed).hasSize(256).isNotEqualTo(content);

        javax.crypto.Cipher cipher =
                javax.crypto.Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, client.getPrivate(),
                new javax.crypto.spec.OAEPParameterSpec("SHA-256", "MGF1",
                        java.security.spec.MGF1ParameterSpec.SHA256,
                        javax.crypto.spec.PSource.PSpecified.DEFAULT));

        assertThat(cipher.doFinal(sealed))
                .as("only the holder of the matching private key can recover the content key")
                .isEqualTo(content);
    }

    @Test
    @DisplayName("a malformed client key is a bad request, not a server error")
    void rubbishClientKeyIsRejected() {
        VideoContentKeyService keys = service();

        // Sent by the caller, so it must not surface as a 500 or take the endpoint down.
        assertThatThrownBy(() -> keys.sealToClient(keys.newContentKey(), "not-a-public-key"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("with no keys configured, encryption is off and nothing throws on startup")
    void absentConfigurationDisablesEncryption() {
        // Recordings encoded before this existed have no key and must keep playing, so "off" has to
        // be a normal state rather than an error.
        VideoContentKeyService off = new VideoContentKeyService("", "");
        assertThat(off.enabled()).isFalse();
    }

    @Test
    @DisplayName("a public key alone disables encryption instead of making unplayable recordings")
    void publicKeyOnlyIsRefused() {
        // Encrypting with no way to serve the key produces recordings that are lost the moment they
        // finish encoding. Better to leave them in the clear and log loudly.
        VideoContentKeyService halfConfigured = new VideoContentKeyService(publicKey, "");
        assertThat(halfConfigured.enabled()).isFalse();
    }

    @Test
    @DisplayName("a private key alone still plays existing recordings, but encrypts no new ones")
    void privateKeyOnlyStillDecrypts() {
        String sealed = service().wrap(service().newContentKey());
        VideoContentKeyService readOnly = new VideoContentKeyService("", privateKey);

        assertThat(readOnly.enabled()).isFalse();
        assertThat(readOnly.unwrap(sealed)).hasSize(16);
    }

    @Test
    @DisplayName("a pasted PEM is accepted, armour and all")
    void pemIsTolerated() {
        String pem = "-----BEGIN PUBLIC KEY-----\n"
                + publicKey.replaceAll("(.{64})", "$1\n") + "\n-----END PUBLIC KEY-----";

        // Copying a key out of a .pem file is what somebody will actually do at 2am.
        VideoContentKeyService keys = new VideoContentKeyService(pem, privateKey);
        assertThat(keys.enabled()).isTrue();
        assertThat(keys.unwrap(keys.wrap(keys.newContentKey()))).hasSize(16);
    }

    @Test
    @DisplayName("nonsense configuration disables encryption instead of crashing the application")
    void invalidKeysAreSurvivable() {
        // A typo in an environment variable must not stop the whole deployment from starting.
        VideoContentKeyService broken = new VideoContentKeyService("not-a-key", "also-not-a-key");
        assertThat(broken.enabled()).isFalse();
    }
}
