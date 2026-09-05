package com.agmsentinel.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Decrypting downloaded segments.
 *
 * <h2>Why this is worth testing rather than trusting</h2>
 * The bug it fixes was invisible from the outside: the download returned 200, the browser saved a
 * file of the expected size, and only opening it revealed ciphertext. Every wrong answer here has
 * that same shape — a plausible file that no player accepts — so nothing downstream would catch a
 * regression. The IV derivation in particular has no observable symptom short of trying to play the
 * result.
 */
class HlsSegmentDecryptorTest {

    /** Encrypt the way FFmpeg's HLS muxer does, so the test decrypts something realistic. */
    private byte[] encrypt(byte[] key, byte[] iv, byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
        return cipher.doFinal(plaintext);
    }

    private byte[] randomKey() {
        byte[] key = new byte[16];
        new SecureRandom().nextBytes(key);
        return key;
    }

    @Test
    @DisplayName("a segment round-trips back to its exact plaintext")
    void roundTrips() throws Exception {
        byte[] key = randomKey();
        byte[] iv = HlsSegmentDecryptor.ivForSequence(0);
        // Starts with the MPEG-TS sync byte, like a real segment.
        byte[] plain = new byte[188 * 3];
        plain[0] = 0x47;
        plain[188] = 0x47;
        plain[376] = 0x47;

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        HlsSegmentDecryptor.decryptTo(key, iv, encrypt(key, iv, plain), out);

        assertThat(out.toByteArray())
                .as("the whole point: what comes out must be playable MPEG-TS")
                .isEqualTo(plain);
        assertThat(out.toByteArray()[0]).isEqualTo((byte) 0x47);
    }

    @Test
    @DisplayName("the IV is the sequence number as a 128-bit big-endian value")
    void ivLayout() {
        // RFC 8216 5.2: with no IV attribute, the media sequence number is used, zero-padded on the
        // left. Getting the byte order or the padding side wrong produces a file that decrypts to
        // noise with no error at all.
        assertThat(HlsSegmentDecryptor.ivForSequence(0))
                .containsExactly(new byte[16]);
        assertThat(HlsSegmentDecryptor.ivForSequence(1))
                .containsExactly(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
        assertThat(HlsSegmentDecryptor.ivForSequence(258))
                .containsExactly(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2);
    }

    @Test
    @DisplayName("each segment decrypts with its own IV, so a joined download is correct")
    void everySegmentUsesItsOwnIv() throws Exception {
        byte[] key = randomKey();
        ByteArrayOutputStream joined = new ByteArrayOutputStream();

        for (int seq = 0; seq < 4; seq++) {
            byte[] plain = ("segment-" + seq + "-payload").getBytes(StandardCharsets.UTF_8);
            byte[] iv = HlsSegmentDecryptor.ivForSequence(seq);
            HlsSegmentDecryptor.decryptTo(key, iv, encrypt(key, iv, plain), joined);
        }

        assertThat(joined.toString(StandardCharsets.UTF_8))
                .isEqualTo("segment-0-payloadsegment-1-payloadsegment-2-payloadsegment-3-payload");
    }

    @Test
    @DisplayName("a wrong IV corrupts ONLY the first block, and does so silently")
    void wrongIvCorruptsSilently() throws Exception {
        byte[] key = randomKey();
        byte[] plain = new byte[64];
        for (int i = 0; i < plain.length; i++) plain[i] = (byte) i;
        byte[] cipher = encrypt(key, HlsSegmentDecryptor.ivForSequence(0), plain);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        HlsSegmentDecryptor.decryptTo(key, HlsSegmentDecryptor.ivForSequence(99), cipher, out);
        byte[] got = out.toByteArray();

        // This test originally asserted that a wrong IV throws. It does not, and the truth matters
        // more than the tidier assertion: in CBC the IV is XORed into the FIRST block only, and the
        // PKCS#7 padding at the END is derived from the last two ciphertext blocks — so padding
        // validation passes and decryption reports success.
        //
        // The consequence is the reason the IV derivation is tested so precisely above: get it wrong
        // and every downloaded file is corrupt in its first 16 bytes, with nothing anywhere raising
        // an error. For MPEG-TS that destroys the opening packet header, which is exactly the part a
        // player reads to decide whether the file is valid at all.
        assertThat(got).hasSize(plain.length);
        assertThat(java.util.Arrays.copyOfRange(got, 0, 16))
                .as("first block is garbage")
                .isNotEqualTo(java.util.Arrays.copyOfRange(plain, 0, 16));
        assertThat(java.util.Arrays.copyOfRange(got, 16, 64))
                .as("everything after the first block decrypts correctly, which is what hides the bug")
                .isEqualTo(java.util.Arrays.copyOfRange(plain, 16, 64));
    }

    @Test
    @DisplayName("a key of the wrong length is refused before any decryption is attempted")
    void wrongKeyLengthIsRefused() {
        assertThatThrownBy(() -> HlsSegmentDecryptor.decryptTo(
                        new byte[8], HlsSegmentDecryptor.ivForSequence(0), new byte[16],
                        new ByteArrayOutputStream()))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("16-byte AES-128 key");

        assertThatThrownBy(() -> HlsSegmentDecryptor.decryptTo(
                        null, HlsSegmentDecryptor.ivForSequence(0), new byte[16],
                        new ByteArrayOutputStream()))
                .isInstanceOf(IOException.class);
    }

    @Test
    @DisplayName("an explicit IV attribute is parsed, with or without the 0x prefix")
    void parsesExplicitIv() {
        byte[] expected = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};

        assertThat(HlsSegmentDecryptor.parseIvAttribute("0x00000000000000000000000000000001"))
                .containsExactly(expected);
        assertThat(HlsSegmentDecryptor.parseIvAttribute("00000000000000000000000000000001"))
                .containsExactly(expected);
        assertThat(HlsSegmentDecryptor.parseIvAttribute("0X000000000000000000000000000000FF"))
                .as("the prefix is case-insensitive in the wild")
                .isNotNull();
    }

    @Test
    @DisplayName("a malformed IV attribute returns null rather than a wrong IV")
    void rejectsMalformedIv() {
        // Null sends the caller to the sequence-number default, which is right. Guessing at a short
        // or non-hex value would decrypt to noise and report success.
        assertThat(HlsSegmentDecryptor.parseIvAttribute(null)).isNull();
        assertThat(HlsSegmentDecryptor.parseIvAttribute("0x1234")).isNull();
        assertThat(HlsSegmentDecryptor.parseIvAttribute("0xZZ000000000000000000000000000001")).isNull();
        assertThat(HlsSegmentDecryptor.parseIvAttribute("")).isNull();
    }
}
