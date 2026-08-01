package com.agmsentinel.service;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Normalises an uploaded subtitle file to WebVTT.
 *
 * <p>Everything is stored as WebVTT because that is the only format {@code <track>} accepts — a
 * stored SRT would need converting on every request, or a second code path in the player. Doing it
 * once on upload means the serving side has nothing to decide.
 *
 * <p>The conversion is small but not nothing: SRT separates its timestamp fields with a comma where
 * VTT uses a period, numbers its cues (which VTT treats as an optional identifier), and is commonly
 * saved with a BOM and CRLF line endings that a strict parser will reject.
 */
@Component
public class SubtitleConverter {

    /** {@code 00:01:02,500 --> 00:01:05,000} — SRT, comma before the millis. */
    private static final Pattern SRT_TIME = Pattern.compile(
            "(\\d{1,2}:\\d{2}:\\d{2})[,.](\\d{1,3})\\s*-->\\s*(\\d{1,2}:\\d{2}:\\d{2})[,.](\\d{1,3})");

    /** A line that is nothing but a cue number, as SRT writes before each cue. */
    private static final Pattern CUE_NUMBER = Pattern.compile("^\\d+$");

    private static final long MAX_BYTES = 2L * 1024 * 1024;   // a 3-hour transcript is ~200 KB

    /**
     * @param filename the uploaded name, used only to pick the input format
     * @return WebVTT text, ready to store and serve
     */
    public String toWebVtt(String filename, byte[] content) {
        if (content == null || content.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The subtitle file is empty.");
        }
        if (content.length > MAX_BYTES) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "Subtitle files are limited to 2 MB. Even a three-hour transcript is well under "
                    + "that, so this is probably not a subtitle file.");
        }

        String text = decode(content);
        String lower = filename == null ? "" : filename.toLowerCase(java.util.Locale.ROOT);

        String vtt;
        if (lower.endsWith(".vtt")) {
            vtt = normaliseVtt(text);
        } else if (lower.endsWith(".srt")) {
            vtt = convertSrt(text);
        } else {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Only .vtt and .srt subtitle files are supported.");
        }

        if (!SRT_TIME.matcher(vtt).find() && !vtt.contains("-->")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "No subtitle cues were found in that file. A transcript needs timestamp lines "
                    + "like \"00:01:02.500 --> 00:01:05.000\".");
        }
        return vtt;
    }

    /**
     * Read as UTF-8 and drop a byte-order mark.
     *
     * <p>A BOM at the start of the file would land inside the {@code WEBVTT} signature, and browsers
     * reject the whole track when that first line does not match exactly — a failure that shows up
     * as "captions do nothing" with nothing logged anywhere.
     */
    private String decode(byte[] content) {
        String text = new String(content, java.nio.charset.StandardCharsets.UTF_8);
        if (!text.isEmpty() && text.charAt(0) == '﻿') text = text.substring(1);
        return text.replace("\r\n", "\n").replace('\r', '\n');
    }

    /** Ensure the file starts with the signature browsers require. */
    private String normaliseVtt(String text) {
        String trimmed = text.stripLeading();
        return trimmed.startsWith("WEBVTT") ? trimmed : "WEBVTT\n\n" + trimmed;
    }

    private String convertSrt(String text) {
        List<String> out = new ArrayList<>();
        out.add("WEBVTT");
        out.add("");

        boolean previousBlank = true;
        for (String raw : text.split("\n")) {
            String line = raw.strip();

            // Cue numbers only carry meaning in SRT, and only at the start of a cue. Dropping them
            // is safe; keeping them would make VTT read each one as a cue identifier.
            if (previousBlank && CUE_NUMBER.matcher(line).matches()) {
                previousBlank = false;
                continue;
            }
            Matcher time = SRT_TIME.matcher(line);
            if (time.find()) {
                out.add(time.group(1) + "." + padMillis(time.group(2))
                        + " --> " + time.group(3) + "." + padMillis(time.group(4)));
            } else {
                out.add(raw);
            }
            previousBlank = line.isEmpty();
        }
        return String.join("\n", out) + "\n";
    }

    /** VTT requires exactly three digits of milliseconds; SRT files in the wild have one to three. */
    private String padMillis(String millis) {
        String digits = millis.length() > 3 ? millis.substring(0, 3) : millis;
        return switch (digits.length()) {
            case 1 -> digits + "00";
            case 2 -> digits + "0";
            default -> digits;
        };
    }
}
