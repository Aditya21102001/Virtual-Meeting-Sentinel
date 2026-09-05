package com.agmsentinel.service;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;

/**
 * Turns AES-128 encrypted HLS segments back into playable MPEG-TS.
 *
 * <h2>Why this exists</h2>
 * Downloading a recording joins its segments end to end. That was written before segment encryption
 * existed and never revisited, so once recordings were encrypted the download produced a file made of
 * ciphertext: the request succeeded, the bytes arrived, the browser saved a {@code .ts}, and no player
 * on earth could open it. A download that fails would have been better — this one looked like it
 * worked.
 *
 * <h2>Where the IV comes from</h2>
 * {@code VideoTranscodeService.writeKeyInfo} writes only the key URI and the key path, with no third
 * line, so FFmpeg emits no {@code IV=} attribute. RFC 8216 §5.2 is explicit about that case: when
 * {@code EXT-X-KEY} carries no IV, <em>the media sequence number is used</em> — as a 128-bit
 * big-endian value, left-padded with zeros.
 *
 * <p>An explicit IV is still honoured, because it is the other legal arrangement and a future change
 * to the key-info file would otherwise break decryption silently rather than loudly.
 *
 * <h2>Why each segment is decrypted independently</h2>
 * Every segment is its own CBC stream with its own IV and its own PKCS#7 padding on the final block.
 * Treating the concatenation as one stream would corrupt the first block after each boundary and
 * leave padding bytes embedded mid-file — which decodes to something a player accepts and then
 * stutters on, the worst of the available failures.
 */
public final class HlsSegmentDecryptor {

    /** AES-128 block size, and therefore the IV length. */
    public static final int IV_LENGTH = 16;

    private HlsSegmentDecryptor() { }

    /**
     * The IV for a segment, given its media sequence number.
     *
     * <p>Big-endian in the low 8 bytes with the high 8 zeroed — the sequence number as a 128-bit
     * integer, which is what the spec asks for and what FFmpeg's muxer used when it wrote these.
     */
    public static byte[] ivForSequence(long sequenceNumber) {
        ByteBuffer iv = ByteBuffer.allocate(IV_LENGTH);
        iv.position(8);                 // leave the first 8 bytes zero
        iv.putLong(sequenceNumber);
        return iv.array();
    }

    /** Parse an {@code IV=0x...} attribute value. Returns null when it is absent or malformed. */
    public static byte[] parseIvAttribute(String value) {
        if (value == null) return null;
        String hex = value.trim();
        if (hex.regionMatches(true, 0, "0x", 0, 2)) hex = hex.substring(2);
        if (hex.length() != IV_LENGTH * 2) return null;
        byte[] iv = new byte[IV_LENGTH];
        for (int i = 0; i < IV_LENGTH; i++) {
            int hi = Character.digit(hex.charAt(i * 2), 16);
            int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) return null;
            iv[i] = (byte) ((hi << 4) | lo);
        }
        return iv;
    }

    /**
     * Decrypt one segment and write the plaintext to {@code out}.
     *
     * <p>Whole-segment rather than streaming: a segment is a few megabytes, and CBC needs the final
     * block to strip padding correctly. Streaming this would mean holding back a block and dealing
     * with the tail by hand, for no memory saving worth the risk of getting it wrong.
     *
     * @param contentKey the 16-byte AES key, already unwrapped
     * @param iv         the segment's IV — see {@link #ivForSequence}
     */
    public static void decryptTo(byte[] contentKey, byte[] iv, byte[] segment, OutputStream out)
            throws IOException {
        if (contentKey == null || contentKey.length != IV_LENGTH) {
            throw new IOException("The content key is not a 16-byte AES-128 key, so this recording "
                                  + "cannot be decrypted for download.");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(Cipher.DECRYPT_MODE,
                        new SecretKeySpec(contentKey, "AES"),
                        new IvParameterSpec(iv));
            out.write(cipher.doFinal(segment));
        } catch (GeneralSecurityException ex) {
            // Wrapped rather than propagated: the caller is streaming an HTTP response and the only
            // useful thing it can do is stop. The message names the segment size because a wrong key
            // and a truncated segment fail identically here, and the size distinguishes them.
            throw new IOException("Could not decrypt a segment of " + segment.length + " bytes. "
                                 + "The stored content key may not match the recording.", ex);
        }
    }
}
