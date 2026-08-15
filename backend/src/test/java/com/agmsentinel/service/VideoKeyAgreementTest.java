package com.agmsentinel.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * ECDH key agreement between the server and a browser.
 *
 * <h2>What this is really testing</h2>
 * Two implementations in two languages have to derive <b>byte-identical</b> secrets: Java's
 * {@code KeyAgreement("ECDH")} here, and WebCrypto's {@code deriveBits} in the browser. Then both
 * have to hash that secret the same way, and agree on AES-GCM's layout.
 *
 * <p>Every one of those is a place where a silent mismatch produces a key that decrypts to noise —
 * and the symptom is a video that will not play, with nothing anywhere naming the cause. So this
 * plays the browser's half explicitly rather than trusting that the two sides look symmetric.
 */
class VideoKeyAgreementTest {

    /** Whatever the browser will do, done here, so a mismatch shows up as a failing test. */
    private byte[] browserSideDecrypt(KeyPair browser, String serverPublicKeyBase64, byte[] sealed)
            throws Exception {
        var serverPublic = KeyFactory.getInstance("EC")
                .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(serverPublicKeyBase64)));

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(browser.getPrivate());
        agreement.doPhase(serverPublic, true);
        byte[] shared = agreement.generateSecret();

        byte[] label = "agm-video-content-key".getBytes(StandardCharsets.UTF_8);
        byte[] material = new byte[shared.length + label.length];
        System.arraycopy(shared, 0, material, 0, shared.length);
        System.arraycopy(label, 0, material, shared.length, label.length);
        byte[] aesKey = MessageDigest.getInstance("SHA-256").digest(material);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(aesKey, "AES"),
                    new GCMParameterSpec(128, Arrays.copyOfRange(sealed, 0, 12)));
        return cipher.doFinal(sealed, 12, sealed.length - 12);
    }

    private static KeyPair browserKeypair() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
        // P-256 — the curve WebCrypto exposes and every browser supports.
        gen.initialize(new ECGenParameterSpec("secp256r1"));
        return gen.generateKeyPair();
    }

    private static String publicOf(KeyPair pair) {
        return Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
    }

    /** Encryption must be configured for content keys to exist at all. */
    private VideoContentKeyService service() throws Exception {
        KeyPairGenerator rsa = KeyPairGenerator.getInstance("RSA");
        rsa.initialize(2048);
        KeyPair pair = rsa.generateKeyPair();
        return new VideoContentKeyService(
                Base64.getEncoder().encodeToString(pair.getPublic().getEncoded()),
                Base64.getEncoder().encodeToString(pair.getPrivate().getEncoded()));
    }

    @Test
    @DisplayName("both sides derive the same secret, and the browser recovers the content key")
    void bothSidesAgree() throws Exception {
        VideoContentKeyService keys = service();
        byte[] contentKey = keys.newContentKey();
        KeyPair browser = browserKeypair();

        byte[] sealed = keys.agreeAndSeal(contentKey, publicOf(browser));

        assertThat(browserSideDecrypt(browser, keys.agreementPublicKey(), sealed))
                .as("if these differ the video decrypts to noise and nothing says why")
                .isEqualTo(contentKey);
    }

    @Test
    @DisplayName("the secret itself never appears in what is transmitted")
    void theContentKeyIsNotOnTheWire() throws Exception {
        VideoContentKeyService keys = service();
        byte[] contentKey = keys.newContentKey();

        byte[] sealed = keys.agreeAndSeal(contentKey, publicOf(browserKeypair()));

        // nonce(12) + ciphertext(16) + tag(16)
        assertThat(sealed).hasSize(44);
        assertThat(indexOf(sealed, contentKey))
                .as("the raw content key must not be recoverable from the response")
                .isEqualTo(-1);
    }

    @Test
    @DisplayName("a different browser keypair cannot read another session's key")
    void aStrangerCannotDecrypt() throws Exception {
        VideoContentKeyService keys = service();
        byte[] sealed = keys.agreeAndSeal(keys.newContentKey(), publicOf(browserKeypair()));

        // Somebody who captured the response but holds a different private key.
        KeyPair eavesdropper = browserKeypair();
        assertThatThrownBy(() -> browserSideDecrypt(eavesdropper, keys.agreementPublicKey(), sealed))
                .isInstanceOf(javax.crypto.AEADBadTagException.class);
    }

    @Test
    @DisplayName("each exchange is freshly nonced, so two responses never repeat")
    void everyExchangeIsUnique() throws Exception {
        VideoContentKeyService keys = service();
        byte[] contentKey = keys.newContentKey();
        String browser = publicOf(browserKeypair());

        // Same key, same client: the ciphertext must still differ, or an observer could tell that
        // two viewers were sent the same content key.
        assertThat(keys.agreeAndSeal(contentKey, browser))
                .isNotEqualTo(keys.agreeAndSeal(contentKey, browser));
    }

    @Test
    @DisplayName("the server's public key is stable within a boot, so one exchange suffices")
    void serverPublicKeyIsStable() throws Exception {
        VideoContentKeyService keys = service();

        // The client fetches it once and caches it for the session; a value that changed per call
        // would make every derivation fail after the first.
        assertThat(keys.agreementPublicKey()).isEqualTo(keys.agreementPublicKey());
    }

    @Test
    @DisplayName("a malformed client key is a bad request, not a server error")
    void rubbishClientKey() throws Exception {
        VideoContentKeyService keys = service();

        assertThatThrownBy(() -> keys.agreeAndSeal(keys.newContentKey(), "not-a-key"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }
}
