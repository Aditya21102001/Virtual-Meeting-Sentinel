package com.agmsentinel.service;

import com.agmsentinel.dto.AuthDtos.LoginResult;
import com.agmsentinel.dto.AuthDtos.RegisterRequest;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.JwtService;
import com.agmsentinel.security.Roles;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * What role a public registration hands out.
 *
 * <h2>Why this is worth pinning</h2>
 * {@code POST /api/auth/register} is public — it must be, since somebody registering cannot yet be
 * authenticated. It once created MODERATOR, which meant anyone who found the sign-up form could
 * give themselves the board, the knowledge base and the ability to publish answers to the room.
 * That is the authorisation model undone by its own front door, and nothing about it looked wrong
 * from the outside.
 *
 * <p>The fix creates members instead. That in turn needs the first-run case below, or a brand-new
 * deployment has no administrator and no way to appoint one: registration makes a member, moderator
 * is granted from the Members screen, and the Members screen needs a moderator. Both halves are
 * tested together because each is only safe while the other holds.
 */
class AuthServiceRegisterTest {

    private AppUserRepository users;
    private AuthService auth;

    @BeforeEach
    void setUp() {
        users = mock(AppUserRepository.class);
        JwtService jwt = mock(JwtService.class);

        auth = new AuthService(users, new BCryptPasswordEncoder(), jwt,
                               mock(WebAuthnService.class), mock(OtpService.class));
        // @Value fields are not injected outside a Spring context.
        ReflectionTestUtils.setField(auth, "registrationDefaultRole", Roles.SHAREHOLDER);

        when(users.existsByUsername(anyString())).thenReturn(false);
        when(users.findByEmail(anyString())).thenReturn(Optional.empty());
        when(users.findByPhone(anyString())).thenReturn(Optional.empty());
        when(users.save(any(AppUser.class))).thenAnswer(call -> call.getArgument(0));
        when(jwt.issue(anyString(), anyString(), any())).thenReturn("token");
    }

    private RegisterRequest request(String username) {
        return new RegisterRequest(username, username + "@example.com", "+911234567890",
                                   "a-good-password");
    }

    private String roleOfSavedUser() {
        ArgumentCaptor<AppUser> saved = ArgumentCaptor.forClass(AppUser.class);
        verify(users).save(saved.capture());
        return saved.getValue().getRole();
    }

    @Test
    @DisplayName("a public registration on a populated system is a member, never a moderator")
    void ordinaryRegistrationIsLeastPrivileged() {
        when(users.count()).thenReturn(7L);

        LoginResult result = auth.register(request("someone"));

        assertThat(result.status()).isEqualTo("AUTHENTICATED");
        assertThat(roleOfSavedUser())
                .as("anyone can reach this endpoint; it must not hand out authority")
                .isEqualTo(Roles.SHAREHOLDER)
                .isNotEqualTo(Roles.MODERATOR)
                .isNotEqualTo(Roles.ADMIN);
    }

    @Test
    @DisplayName("the very first account on an empty database is an admin, so the system is usable")
    void theFirstAccountBootstrapsAnAdministrator() {
        when(users.count()).thenReturn(0L);

        auth.register(request("the-person-installing-this"));

        assertThat(roleOfSavedUser())
                .as("without this a fresh deployment has no administrator and no way to appoint one")
                .isEqualTo(Roles.ADMIN);
    }

    @Test
    @DisplayName("a misconfigured default role fails toward less privilege, not more")
    void anInvalidConfiguredRoleFallsBackToMember() {
        ReflectionTestUtils.setField(auth, "registrationDefaultRole", "SUPREME_LEADER");
        when(users.count()).thenReturn(3L);

        auth.register(request("someone-else"));

        assertThat(roleOfSavedUser()).isEqualTo(Roles.SHAREHOLDER);
    }
}
