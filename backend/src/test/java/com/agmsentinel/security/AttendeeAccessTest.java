package com.agmsentinel.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * What an anonymous ATTENDEE token may and may not reach.
 *
 * <h2>Why this test exists</h2>
 * {@code /api/auth/attendee} is public and issues a token for <b>whatever username the caller
 * types</b> — no password, no verification. That is deliberate: someone in the room should be able
 * to ask a question without an account, and the name is only a label.
 *
 * <p>The trap is that such a token still satisfies Spring Security's {@code .authenticated()}. The
 * chat routes used that rule, and the result was reachable from the open internet in two requests
 * with no credentials: the full text of the indexed annual report, the directory of every
 * registered user with their roles, and answers from the language model billed to the deployment.
 *
 * <p>Nothing failed. Nothing was logged. The endpoints did exactly what they had been told to do,
 * which is why a test — rather than care — is what keeps this shut.
 *
 * <p>{@code SecurityConfig} already applied the right rule to voting, with a comment explaining
 * precisely this hazard. These cases hold the chat routes to the same standard, and equally check
 * that the anonymous pass still WORKS for the things it is meant to cover — a fix that quietly
 * locked attendees out of asking questions would be its own kind of broken.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AttendeeAccessTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private JwtService jwt;

    /** A token exactly as {@code /api/auth/attendee} mints one: any name, nothing verified. */
    private String attendeeToken() {
        return jwt.issue("somebody-who-just-typed-a-name", Roles.ATTENDEE);
    }

    private String shareholderToken() {
        return jwt.issue("a-real-member", Roles.SHAREHOLDER, List.of(Roles.SHAREHOLDER));
    }

    private int statusOf(String path, String token) throws Exception {
        MvcResult result = mvc.perform(post(path)
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andReturn();
        return result.getResponse().getStatus();
    }

    @Test
    @DisplayName("an unverified attendee cannot read the company's indexed documents")
    void documentsAreClosedToAttendees() throws Exception {
        assertThat(statusOf("/api/chat/semantic-search", attendeeToken()))
                .as("semantic search returns passages from the annual report and any uploaded "
                    + "transcript — it must require a real account")
                .isEqualTo(403);
    }

    @Test
    @DisplayName("an unverified attendee cannot read the member directory or send messages")
    void theDirectoryAndMessagingAreClosedToAttendees() throws Exception {
        assertThat(statusOf("/api/chat/list-contacts", attendeeToken()))
                .as("the directory names every registered user and their role")
                .isEqualTo(403);
        assertThat(statusOf("/api/chat/send-message", attendeeToken()))
                .as("anyone able to message members could phish them from an anonymous token")
                .isEqualTo(403);
        assertThat(statusOf("/api/chat/load-thread", attendeeToken())).isEqualTo(403);
    }

    @Test
    @DisplayName("an unverified attendee cannot spend the deployment's model budget")
    void theAssistantIsClosedToAttendees() throws Exception {
        assertThat(statusOf("/api/chat/ask-assistant", attendeeToken()))
                .as("each call costs money and is billed to whoever runs this deployment")
                .isEqualTo(403);
    }

    @Test
    @DisplayName("a real member is still let through to the same routes")
    void membersAreNotLockedOut() throws Exception {
        // Not asserting 200: these routes sit behind feature flags too, and SEMANTIC_SEARCH ships
        // disabled, so a permitted caller may still legitimately get 404 ("not enabled here").
        // What matters is that the SECURITY layer did not refuse them — 403 is the failure to
        // watch for, and it is the one an over-broad fix would cause.
        assertThat(statusOf("/api/chat/semantic-search", shareholderToken()))
                .as("a shareholder must not be refused by the role rules")
                .isNotEqualTo(403);
        assertThat(statusOf("/api/chat/list-contacts", shareholderToken()))
                .isNotEqualTo(403);
    }

    @Test
    @DisplayName("the anonymous pass still covers what it is for: asking and supporting")
    void attendeesKeepTheRoom() throws Exception {
        // The whole point of the ATTENDEE role. If this ever starts returning 403, the lockdown
        // above has gone too far and the people the application exists to serve cannot take part.
        assertThat(statusOf("/api/room/attendee-board", attendeeToken()))
                .as("attendees must still see the ranked topics")
                .isNotEqualTo(403);
        assertThat(statusOf("/api/room/support-topic", attendeeToken()))
                .as("an upvote ranks a discussion topic and decides nothing — it stays open")
                .isNotEqualTo(403);
    }
}
