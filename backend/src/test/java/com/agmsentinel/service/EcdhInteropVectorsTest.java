package com.agmsentinel.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

/**
 * Emits ECDH test vectors for the browser half to check itself against.
 *
 * <h2>Why this is needed</h2>
 * The other agreement tests run Java on both sides. That proves the construction is
 * self-consistent — it does <b>not</b> prove that WebCrypto's {@code deriveBits} produces the same
 * bytes as Java's {@code KeyAgreement}, which is the assumption the whole feature rests on. If they
 * differ, the derived AES key is wrong, the content key decrypts to noise, and the only symptom is
 * a video that will not play.
 *
 * <p>So this writes a fixed keypair and Java's answer to a file, and a browser script derives the
 * same value independently and compares. Two languages, one expected number.
 *
 * <p>Disabled by default — it produces a file rather than asserting anything, and only exists to
 * feed the browser check. Run it with {@code -Decdh.vectors=<path>}.
 */
class EcdhInteropVectorsTest {

    @Test
    @EnabledIfSystemProperty(named = "ecdh.vectors", matches = ".+")
    @DisplayName("write vectors for the browser to verify against")
    void writeVectors() throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
        gen.initialize(new ECGenParameterSpec("secp256r1"));

        KeyPair server = gen.generateKeyPair();
        KeyPair client = gen.generateKeyPair();

        // Java's side of the agreement, exactly as VideoContentKeyService computes it.
        javax.crypto.KeyAgreement agreement = javax.crypto.KeyAgreement.getInstance("ECDH");
        agreement.init(server.getPrivate());
        agreement.doPhase(client.getPublic(), true);
        byte[] shared = agreement.generateSecret();

        byte[] label = "agm-video-content-key".getBytes(StandardCharsets.UTF_8);
        byte[] material = new byte[shared.length + label.length];
        System.arraycopy(shared, 0, material, 0, shared.length);
        System.arraycopy(label, 0, material, shared.length, label.length);
        byte[] aesKey = MessageDigest.getInstance("SHA-256").digest(material);

        Base64.Encoder b64 = Base64.getEncoder();
        String json = "{\n"
                + "  \"serverPublicSpki\": \"" + b64.encodeToString(server.getPublic().getEncoded()) + "\",\n"
                + "  \"clientPrivatePkcs8\": \"" + b64.encodeToString(client.getPrivate().getEncoded()) + "\",\n"
                + "  \"clientPublicSpki\": \"" + b64.encodeToString(client.getPublic().getEncoded()) + "\",\n"
                + "  \"expectedSharedBits\": \"" + b64.encodeToString(shared) + "\",\n"
                + "  \"expectedAesKey\": \"" + b64.encodeToString(aesKey) + "\"\n"
                + "}\n";

        Path out = Path.of(System.getProperty("ecdh.vectors"));
        Files.createDirectories(out.getParent());
        Files.writeString(out, json, StandardCharsets.UTF_8);
        System.out.println("ECDH vectors written to " + out);
    }
}
