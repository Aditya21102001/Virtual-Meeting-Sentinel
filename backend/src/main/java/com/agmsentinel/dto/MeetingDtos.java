package com.agmsentinel.dto;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.model.MeetingMember;

import java.time.Instant;
import java.util.UUID;

/** Wire shapes for meeting management. */
public final class MeetingDtos {

    private MeetingDtos() { }

    /** A meeting as the management screen sees it. */
    public record MeetingView(
            UUID id,
            String title,
            String description,
            Instant scheduledAt,
            /** DRAFT · ACTIVE · CLOSED. */
            String status,
            boolean active,
            String createdBy,
            Instant activatedAt,
            Instant closedAt,
            Instant createdAt,
            /** Resolved in one batched query for the whole page, not per row. */
            long memberCount,
            /** Share of total entitlement that must be represented for business to be valid. */
            double quorumThresholdPercent) {

        public static MeetingView of(Meeting meeting, long memberCount) {
            return new MeetingView(
                    meeting.getId(), meeting.getTitle(), meeting.getDescription(),
                    meeting.getScheduledAt(), meeting.getStatus().name(), meeting.isActive(),
                    meeting.getCreatedBy(), meeting.getActivatedAt(), meeting.getClosedAt(),
                    meeting.getCreatedAt(), memberCount, meeting.getQuorumThresholdPercent());
        }
    }

    /**
     * One person mapped to a meeting.
     *
     * <p>{@code roleInMeeting} describes what they are <em>at this meeting</em> and grants nothing —
     * authorisation comes from the application roles, never from here.
     */
    public record MeetingMemberView(
            UUID id,
            UUID meetingId,
            String username,
            String roleInMeeting,
            /** Shares held, or 1 for one-member-one-vote. Set by a user manager, never by the voter. */
            int votingWeight,
            String addedBy,
            Instant createdAt) {

        public static MeetingMemberView of(MeetingMember member) {
            return new MeetingMemberView(member.getId(), member.getMeetingId(), member.getUsername(),
                    member.getRoleInMeeting(), member.getVotingWeight(), member.getAddedBy(),
                    member.getCreatedAt());
        }
    }
}
