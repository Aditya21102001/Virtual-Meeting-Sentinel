package com.agmsentinel.model;

/** Lifecycle of an uploaded video. The player only offers rows in {@link #READY}. */
public enum VideoStatus {
    /** Bytes have landed on the NAS; the transcode job has not started yet. */
    UPLOADED,
    /** ffmpeg is running: probing, cutting segments, building the poster + seek sprite. */
    PROCESSING,
    /** Manifest + segments are on the NAS and indexed in the DB — playable on demand. */
    READY,
    /** Probe or transcode failed; {@code errorMessage} says why. Re-processable from the UI. */
    FAILED
}
