package com.agmsentinel.model;

import jakarta.persistence.*;
import java.util.UUID;

/**
 * A named point in a recording — "Item 4 — Auditor's Report" at 31:05.
 *
 * <h2>Why a table rather than a WebVTT chapters file</h2>
 * WebVTT is the interchange format for chapters, and storing one would have avoided a table. It was
 * rejected because chapters here are edited far more than they are imported: a moderator watches the
 * recording back and marks the agenda items, adjusting them as they go. Round-tripping that through
 * a text file means re-parsing and re-writing the whole file on every rename, with no way to order
 * or index anything. Rows also let the agenda be queried — "which recordings discussed
 * remuneration" — which is the question this exists to answer for an AGM.
 *
 * <h2>Only a start time</h2>
 * A chapter ends where the next one begins, so an end time would be a second copy of the same fact
 * and the two could disagree. The last chapter runs to the end of the recording. This is how WebVTT,
 * YouTube and Matroska all model it, and it makes an edit local: moving one boundary cannot leave a
 * gap or an overlap, because there is only one number to move.
 */
@Entity
@Table(name = "video_chapters", indexes =
        @Index(name = "video_chapters_video_idx", columnList = "video_id"))
public class VideoChapter {

    /** Titles are agenda lines, not prose. Long enough for a real one, short enough to render. */
    public static final int MAX_TITLE_LENGTH = 200;

    @Id
    @GeneratedValue
    private UUID id;

    /**
     * Plain id rather than a {@code @ManyToOne}, matching VideoComment and VideoLike rather than
     * VideoRendition. The distinction in this schema is authorship: renditions and segments ARE the
     * media, so they hang off the video and are cascaded with it. Chapters are something a person
     * wrote about the media, like a comment — they are read on their own, deleted in bulk, and must
     * never drag a Video into the session just to render a list.
     */
    @Column(name = "video_id", nullable = false)
    private UUID videoId;

    /**
     * Where the chapter begins, in seconds from the start of the recording.
     *
     * <p>Seconds rather than a segment index: chapter boundaries are chosen against what someone
     * heard, and the ladder can be re-encoded with a different segment length at any time — which
     * would silently move every chapter if they were pinned to segments.
     */
    @Column(name = "start_seconds", nullable = false)
    private double startSeconds;

    @Column(nullable = false, length = MAX_TITLE_LENGTH)
    private String title;

    /**
     * Display order, assigned from the sorted start times when a set is saved.
     *
     * <p>Redundant with {@code startSeconds} by construction, and kept anyway: it gives the client a
     * stable "chapter 3 of 7" without it having to re-derive positions, and it makes an out-of-order
     * write visible in the table rather than only in a query's ORDER BY.
     */
    @Column(nullable = false)
    private int ordinal;

    protected VideoChapter() { }

    public VideoChapter(UUID videoId, double startSeconds, String title, int ordinal) {
        this.videoId = videoId;
        this.startSeconds = startSeconds;
        this.title = title;
        this.ordinal = ordinal;
    }

    public UUID getId() { return id; }
    public UUID getVideoId() { return videoId; }
    public void setVideoId(UUID videoId) { this.videoId = videoId; }
    public double getStartSeconds() { return startSeconds; }
    public void setStartSeconds(double startSeconds) { this.startSeconds = startSeconds; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public int getOrdinal() { return ordinal; }
    public void setOrdinal(int ordinal) { this.ordinal = ordinal; }
}
