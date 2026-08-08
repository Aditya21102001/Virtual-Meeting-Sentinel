package com.agmsentinel.controller;

import com.agmsentinel.security.Feature;
import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.QuestionService;
import com.agmsentinel.service.RunOfShowService;
import com.agmsentinel.service.RunOfShowService.TopicView;
import jakarta.validation.constraints.NotNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The room's view of the meeting, and the chair's control of it.
 *
 * <p>Three features behind three separate flags, deliberately, even though they share a service. A
 * deployment may well want attendees to see the topics without letting them vote on the order, or
 * want a running order without showing the room anything at all.
 *
 * <h2>Who may see an answer</h2>
 * {@code attendee-board} returns an answer only once a moderator has published it. Nearly every
 * answer on the board was drafted by a model and read by nobody, and showing those to the room
 * attributes to the company something it never said. {@code run-of-show} is the moderator's view and
 * shows everything.
 *
 * <h2>Why upvoting accepts an anonymous identity when voting does not</h2>
 * An attendee pass is self-asserted — anybody can claim any name. That is fine here: an upvote ranks
 * a discussion topic and decides nothing. It is emphatically not fine for a resolution, which is why
 * {@code VotingController} refuses the same token.
 */
@RestController
@RequestMapping("/api/room")
public class RunOfShowController {

    private final RunOfShowService room;
    private final QuestionService questions;

    public RunOfShowController(RunOfShowService room, QuestionService questions) {
        this.room = room;
        this.questions = questions;
    }

    public record TopicRef(@NotNull UUID clusterId) { }

    public record BoardRequest(Integer limit) { }

    public record RunOrderRequest(List<UUID> clusterIds) { }

    public record PublishRequest(@NotNull UUID clusterId, boolean published) { }

    /** The ranked topics, as the room sees them. Published answers only. */
    @RequiresFeature(Feature.ATTENDEE_BOARD)
    @PostMapping("/attendee-board")
    public List<TopicView> attendeeBoard(@RequestBody(required = false) BoardRequest req) {
        int limit = req == null || req.limit() == null ? 20 : req.limit();
        return room.attendeeBoard(currentSubject(), limit);
    }

    /**
     * Support a topic, or withdraw support.
     *
     * <p>Toggles: tapping again takes it back. A count that can only go up is a count that only ever
     * drifts.
     */
    @RequiresFeature(Feature.CLUSTER_UPVOTE)
    @PostMapping("/support-topic")
    public Map<String, Object> supportTopic(@RequestBody TopicRef req) {
        long supported = room.toggleSupport(req.clusterId(), currentSubject());
        return Map.of("clusterId", req.clusterId(), "supported", supported);
    }

    // ---- the chair's controls (MODERATOR/ADMIN via SecurityConfig) -------------

    /** Every topic with its position, timings and unpublished answers — the moderator's view. */
    @RequiresFeature(Feature.RUN_OF_SHOW)
    @PostMapping("/run-of-show")
    public List<TopicView> runOfShow() {
        return room.runOfShow(currentSubject());
    }

    /** Set the whole running order at once. Anything left out has its position cleared. */
    @RequiresFeature(Feature.RUN_OF_SHOW)
    @PostMapping("/set-run-order")
    public List<TopicView> setRunOrder(@RequestBody RunOrderRequest req) {
        room.setRunOrder(req.clusterIds() == null ? List.of() : req.clusterIds(), currentSubject());
        return room.runOfShow(currentSubject());
    }

    /** Begin taking a topic. Whatever was under discussion is closed off automatically. */
    @RequiresFeature(Feature.RUN_OF_SHOW)
    @PostMapping("/start-topic")
    public List<TopicView> startTopic(@RequestBody TopicRef req) {
        room.startTopic(req.clusterId(), currentSubject());
        return room.runOfShow(currentSubject());
    }

    @RequiresFeature(Feature.RUN_OF_SHOW)
    @PostMapping("/end-topic")
    public List<TopicView> endTopic(@RequestBody TopicRef req) {
        room.endTopic(req.clusterId(), currentSubject());
        return room.runOfShow(currentSubject());
    }

    /**
     * Release an answer to the room, or take it back down.
     *
     * <p>Gated on the attendee board rather than the run of show: publishing only means anything
     * where there is somewhere for the answer to appear.
     */
    @RequiresFeature(Feature.ATTENDEE_BOARD)
    @PostMapping("/publish-answer")
    public Map<String, Object> publishAnswer(@RequestBody PublishRequest req) {
        boolean published = room.setPublished(req.clusterId(), req.published(), currentSubject());
        questions.broadcastBoard();   // moderators watching the board see the change immediately
        return Map.of("clusterId", req.clusterId(), "published", published);
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? null : String.valueOf(auth.getName());
    }
}
