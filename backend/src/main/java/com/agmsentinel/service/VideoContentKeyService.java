package com.agmsentinel.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import java.nio.charset.StandardCharsets;
import java.security.spec.ECGenParameterSpec;
import java.security.MessageDigest;
import java.security.KeyPairGenerator;
import java.security.KeyPair;
import javax.crypto.spec.SecretKeySpec;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.KeyAgreement;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import java.security.spec.AlgorithmParameterSpec;

/**
 * Content keys for HLS encryption: AES-128 for the video, RSA for the key that unlocks it.
 *
 * <h2>Why two algorithms, and not just RSA</h2>
 * This is a hybrid scheme because neither algorithm can do the whole job.
 *
 * <ul>
 *   <li><b>The segments must be AES-128.</b> Not a preference — the HLS specification defines
 *       {@code METHOD=AES-128}, and that is what every player implements. A segment encrypted any
 *       other way is a segment nothing can play.</li>
 *   <li><b>RSA cannot encrypt bulk data anyway.</b> A 2048-bit key encrypts at most ~190 bytes per
 *       operation under OAEP, and is thousands of times slower than AES. Encrypting an hour of
 *       video with it is not slow, it is impossible.</li>
 * </ul>
 *
 * <p>So the video is encrypted with a random 16-byte AES key, and <b>that key</b> — 16 bytes,
 * comfortably inside RSA's limit — is encrypted with RSA. This is the standard construction, and
 * the same one TLS and PGP use, for the same reasons.
 *
 * <h2>What asymmetry buys here</h2>
 * With symmetric wrapping, whatever can encrypt a recording can also decrypt every other one. With
 * RSA the two capabilities separate:
 *
 * <ul>
 *   <li>the <b>public</b> key wraps a content key, and is all the transcoder ever needs;</li>
 *   <li>the <b>private</b> key unwraps it, and is needed only when serving a key to a player.</li>
 * </ul>
 *
 * <p>The public key can therefore be treated as non-secret — in configuration, in a repository, on
 * a build machine — and a compromise of the encoding side yields no ability to read anything. In
 * this deployment both halves sit in the same environment, so that separation is latent rather than
 * realised; it becomes real the moment transcoding moves to its own worker, which is exactly the
 * direction this pipeline is going.
 *
 * <h2>What this protects, and what it does not</h2>
 * It protects the segments <b>at rest</b>. In {@code database} storage mode — which a host with no
 * persistent volume requires — every {@code .ts} segment is a row in {@code video_assets}. Without
 * this, a database dump, a backup, a read replica or a leaked connection string hands somebody
 * playable board recordings. With it, those rows are ciphertext and the private key is not in the
 * database.
 *
 * <p>It is <b>not</b> DRM. The content key is delivered to the browser in order to play the video,
 * so anyone entitled to watch a recording can also extract its key and keep a copy — {@code ffmpeg}
 * and {@code yt-dlp} do precisely that, automatically. If the requirement is "authorised viewers
 * must not be able to keep a copy", this is the wrong mechanism; that needs Widevine or FairPlay.
 *
 * <h2>Configuration</h2>
 * Generate a keypair:
 *
 * <pre>{@code
 * openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem
 * openssl rsa -in private.pem -pubout -out public.pem
 * # strip the PEM header/footer and newlines; the values below are raw base64
 * }</pre>
 *
 * Then set {@code VIDEO_ENCRYPTION_PUBLIC_KEY} (base64 X.509 SubjectPublicKeyInfo) and
 * {@code VIDEO_ENCRYPTION_PRIVATE_KEY} (base64 PKCS#8). With neither set, encryption is off and
 * recordings are processed exactly as before — which it must be, because recordings encoded before
 * this existed have no key and have to keep playing.
 *
 * <p><b>The private key cannot be rotated casually.</b> Every existing recording's content key is
 * wrapped to its public half; replacing the pair makes them all unplayable, and losing the private
 * key does so permanently.
 */
@Service
public class VideoContentKeyService {

    private static final Logger log = LoggerFactory.getLogger(VideoContentKeyService.class);

    /** AES-128 for the content key: the length HLS mandates. */
    private static final int CONTENT_KEY_BYTES = 16;

    /**
     * OAEP, not PKCS#1 v1.5.
     *
     * <p>PKCS#1 v1.5 is still the default people reach for and is vulnerable to Bleichenbacher's
     * adaptive chosen-ciphertext attack, which recovers plaintext from an oracle that merely
     * distinguishes padding errors. OAEP is the modern padding and has no such structure.
     */
    private static final String TRANSFORM = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding";

    /**
     * Spelled out rather than left to the provider.
     *
     * <p>Some JDK providers read "OAEPWithSHA-256AndMGF1Padding" as SHA-256 for the label digest but
     * <em>SHA-1</em> inside MGF1. That still works — until the other side assumes SHA-256 for both
     * and decryption fails for no visible reason. Stating both removes the ambiguity.
     */
    private static final AlgorithmParameterSpec OAEP = new OAEPParameterSpec(
            "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT);

    private final SecureRandom random = new SecureRandom();
    private final PublicKey publicKey;
    private final PrivateKey privateKey;

    public VideoContentKeyService(
            @Value("${video.encryption.public-key:}") String publicKeyBase64,
            @Value("${video.encryption.private-key:}") String privateKeyBase64) {

        this.publicKey = parsePublic(publicKeyBase64);
        this.privateKey = parsePrivate(privateKeyBase64);

        if (publicKey == null && privateKey == null) {
            log.info("Video encryption is OFF — no RSA keypair configured. Segments are stored "
                     + "unencrypted, as before.");
        } else if (publicKey == null) {
            // Serving keys without being able to make new ones: existing recordings still play.
            log.warn("Video encryption: PRIVATE key only. Existing encrypted recordings will play, "
                     + "but new uploads will NOT be encrypted — set the public key too.");
        } else if (privateKey == null) {
            // Encrypting without being able to serve keys makes every new recording unplayable, so
            // this is a misconfiguration rather than a mode.
            log.error("Video encryption: PUBLIC key only. New recordings would be encrypted with no "
                      + "way to serve their keys, so encryption is DISABLED. Set the private key.");
        } else {
            log.info("Video encryption is ON — AES-128 segments, content keys wrapped with RSA.");
        }
    }

    /**
     * Whether new recordings should be encrypted.
     *
     * <p>Requires <b>both</b> halves. Encrypting with only a public key would produce recordings
     * whose keys can never be served — irrecoverable, and discovered only when somebody presses
     * play.
     */
    public boolean enabled() {
        return publicKey != null && privateKey != null;
    }

    /** A fresh 16-byte AES content key for one recording. */
    public byte[] newContentKey() {
        byte[] key = new byte[CONTENT_KEY_BYTES];
        random.nextBytes(key);
        return key;
    }

    /**
     * Wrap a content key for storage, with the public half.
     *
     * @return base64 RSA ciphertext, safe to keep in the database
     */
    public String wrap(byte[] contentKey) {
        if (publicKey == null) {
            throw new IllegalStateException(
                    "No RSA public key configured, so a content key cannot be wrapped.");
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, publicKey, OAEP);
            return Base64.getEncoder().encodeToString(cipher.doFinal(contentKey));
        } catch (Exception e) {
            // Deliberately fatal. Carrying on would write segments nobody can ever decrypt.
            throw new IllegalStateException("Could not wrap the video content key.", e);
        }
    }

    /**
     * Recover a content key in order to serve it to a player, with the private half.
     *
     * @throws IllegalStateException when the key was wrapped to a different keypair, or the stored
     *                               value is damaged — both of which mean the recording cannot play
     */
    public byte[] unwrap(String stored) {
        if (privateKey == null) {
            throw new IllegalStateException(
                    "No RSA private key configured, so this recording's content key cannot be read.");
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, privateKey, OAEP);
            return cipher.doFinal(Base64.getDecoder().decode(stored));
        } catch (Exception e) {
            // By far the likeliest cause is a replaced keypair, so name it — "decryption failed"
            // would send somebody hunting through the video pipeline for a configuration problem.
            throw new IllegalStateException(
                    "Could not unwrap this recording's content key. It was wrapped with a different "
                    + "RSA keypair than the one currently configured.", e);
        }
    }

    /**
     * Re-encrypt a content key to a public key the CLIENT generated, so the raw key never crosses
     * the network even inside TLS.
     *
     * <h3>What this is for</h3>
     * The player generates an RSA keypair in the browser, keeps the private half in memory, and
     * sends only the public half with its key request. This method seals the AES key to it. The
     * only key material that ever travels is a public key going one way and a ciphertext coming
     * back.
     *
     * <h3>What it defends against — and what it does not</h3>
     * It removes the raw key from anything that can see inside TLS: a terminating proxy, a CDN or
     * WAF that mirrors traffic, an access log that records response bodies. Those are real in
     * hosted deployments, and TLS alone does not cover them because TLS ends at the edge, not at
     * this application.
     *
     * <p>It does <b>nothing</b> against the viewer. The browser must hold the plaintext AES key to
     * decrypt the video, so anyone with devtools can still read it. That is the DRM problem and no
     * key exchange solves it.
     *
     * @param clientPublicKeyBase64 the browser's public key, base64 X.509 SubjectPublicKeyInfo
     */
    public byte[] sealToClient(byte[] contentKey, String clientPublicKeyBase64) {
        PublicKey clientKey;
        try {
            clientKey = KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(decode(clientPublicKeyBase64)));
        } catch (Exception e) {
            // A malformed client key is a bad request, not a server fault — the caller sent it.
            throw new IllegalArgumentException("That is not a valid RSA public key.", e);
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, clientKey, OAEP);
            return cipher.doFinal(contentKey);
        } catch (Exception e) {
            throw new IllegalStateException("Could not seal the content key to the client.", e);
        }
    }

    // ---- ECDH key agreement: both sides publish a public key ------------------

    /**
     * This server's ephemeral ECDH keypair, regenerated on every boot.
     *
     * <p>Ephemeral on purpose. It authenticates nothing — TLS already does that — and its only job
     * is to agree a secret with one browser for a few seconds. Regenerating it per boot gives
     * forward secrecy for free: a key recovered from a heap dump later cannot decrypt a session
     * that happened before the last restart. Nothing needs configuring, and nothing breaks on
     * restart beyond clients fetching the new public value.
     */
    private final KeyPair agreementPair = generateAgreementPair();

    /** This server's ECDH public key, base64 X.509. Safe to publish — that is the point. */
    public String agreementPublicKey() {
        return Base64.getEncoder().encodeToString(agreementPair.getPublic().getEncoded());
    }

    /**
     * Encrypt a content key so that only the holder of {@code clientPublicKeyBase64}'s private half
     * can read it, using a secret neither side transmitted.
     *
     * <h3>How the shared secret appears on both sides</h3>
     * Each party combines its own PRIVATE key with the other's PUBLIC key, and — this is the whole
     * trick of Diffie-Hellman — both arrive at the same value:
     *
     * <pre>
     *   server: ECDH(server private, client public)  ─┬─►  identical 32 bytes
     *   client: ECDH(client private, server public)  ─┘
     * </pre>
     *
     * <p>So the secret is never sent. Only two public keys cross the network, in opposite
     * directions, and an observer holding both still cannot derive it.
     *
     * <h3>Why HKDF and then AES-GCM</h3>
     * The raw ECDH output is a curve point, not a uniformly random key, so it is run through HKDF
     * before use. AES-GCM then encrypts the 16-byte content key under it, which authenticates as
     * well as encrypts — a tampered response fails rather than decrypting to a key that would
     * produce silent video noise.
     *
     * @return {@code nonce(12) || ciphertext || tag(16)}
     */
    public byte[] agreeAndSeal(byte[] contentKey, String clientPublicKeyBase64) {
        try {
            PublicKey clientKey = KeyFactory.getInstance("EC")
                    .generatePublic(new X509EncodedKeySpec(decode(clientPublicKeyBase64)));

            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(agreementPair.getPrivate());
            agreement.doPhase(clientKey, true);
            byte[] shared = agreement.generateSecret();

            // HKDF-Extract/Expand, kept simple: SHA-256 over the shared secret with a fixed label.
            // The label binds the derived key to this purpose, so the same exchange cannot be
            // reused to derive a key for anything else added later.
            byte[] aesKey = MessageDigest.getInstance("SHA-256")
                    .digest(concat(shared, "agm-video-content-key".getBytes(StandardCharsets.UTF_8)));

            byte[] nonce = new byte[12];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(aesKey, "AES"),
                        new GCMParameterSpec(128, nonce));
            byte[] sealed = cipher.doFinal(contentKey);

            return concat(nonce, sealed);
        } catch (java.security.spec.InvalidKeySpecException | java.security.InvalidKeyException
                 | IllegalArgumentException bad) {
            // Everything the CALLER controls lands here, and it must stay a 400.
            //
            // IllegalArgumentException is in this list because Base64.decode throws it for input
            // that is not base64 at all — which is the most likely malformed value of the lot. Left
            // to the catch below it was re-wrapped as IllegalStateException and surfaced as a 500,
            // blaming the server for a value the client sent.
            throw new IllegalArgumentException("That is not a valid ECDH public key.", bad);
        } catch (Exception e) {
            throw new IllegalStateException("Could not agree a key with the client.", e);
        }
    }

    private static KeyPair generateAgreementPair() {
        try {
            KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
            // P-256: what WebCrypto exposes as P-256, and the only curve every browser supports.
            gen.initialize(new ECGenParameterSpec("secp256r1"));
            return gen.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException("Could not generate the ECDH keypair.", e);
        }
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private PublicKey parsePublic(String base64) {
        if (base64 == null || base64.isBlank()) return null;
        try {
            return KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(decode(base64)));
        } catch (Exception e) {
            log.error("VIDEO_ENCRYPTION_PUBLIC_KEY is not a valid base64 X.509 RSA public key ({}). "
                      + "Encryption stays off.", e.getMessage());
            return null;
        }
    }

    private PrivateKey parsePrivate(String base64) {
        if (base64 == null || base64.isBlank()) return null;
        try {
            return KeyFactory.getInstance("RSA")
                    .generatePrivate(new PKCS8EncodedKeySpec(decode(base64)));
        } catch (Exception e) {
            log.error("VIDEO_ENCRYPTION_PRIVATE_KEY is not a valid base64 PKCS#8 RSA private key "
                      + "({}). Encryption stays off.", e.getMessage());
            return null;
        }
    }

    /** Tolerate a pasted PEM: strip the armour and whitespace before decoding. */
    private static byte[] decode(String value) {
        String cleaned = value
                .replaceAll("-----BEGIN [A-Z ]+-----", "")
                .replaceAll("-----END [A-Z ]+-----", "")
                .replaceAll("\\s", "");
        return Base64.getDecoder().decode(cleaned);
    }
}
