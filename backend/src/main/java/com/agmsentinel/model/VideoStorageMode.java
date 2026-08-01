package com.agmsentinel.model;

/**
 * Where a video's media bytes actually live.
 *
 * <p>Recorded <b>per video</b>, not just globally, so changing the server-wide default never
 * strands recordings that were already stored the other way.
 */
public enum VideoStorageMode {

    /**
     * Files on the NAS share (or the local fallback). The right answer whenever durable
     * filesystem storage exists: streaming a range of a file is what filesystems are good at.
     */
    FILESYSTEM,

    /**
     * Bytes in the database, as rows in {@code video_assets}. For hosts with no persistent
     * volume — a free-tier container filesystem is wiped on every redeploy, which silently
     * destroys recordings stored on it.
     *
     * <p>FFmpeg still needs real files to read and write, so processing always happens in a local
     * working directory; that directory is ingested into the database and then deleted. Durability
     * comes from the database, so the working directory is free to be ephemeral.
     */
    DATABASE
}
