package com.agmsentinel.service;

import com.agmsentinel.dto.AuthDtos.LoginRequest;
import com.agmsentinel.dto.AuthDtos.LoginResult;
import com.agmsentinel.model.AppUser;
import com.agmsentinel.repository.AppUserRepository;
import com.agmsentinel.security.JwtService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * What a user may type in the "username" box at sign-in.
 *
 * <h2>Why this test exists</h2>
 * A real user changed their password successfully and was then told "invalid username or password"
 * for that exact new password. Nothing was broken in the change itself — the account was keyed by a
 * username they did not know they had.
 *
 * <p>The cause is that the two halves of the system identify people differently. Account recovery
 * sends a one-time code to an <b>email address</b> and finds the account with {@code findByEmail}.
 * Sign-in used to find the account with {@code findByUsername} alone. Anyone whose username is not
 * their email — everyone who arrived through Google, whose username is GENERATED from their display
 * name — could therefore recover an account they could not then sign in to. The password was fine;
 * the identifier was not.
 *
 * <p>So sign-in now accepts either. These cases pin that down, including the one that would throw
 * rather than merely refuse.
 */
class AuthServiceLoginTest {

    private AppUserRepository users;
    private JwtService jwt;
    private AuthService auth;

    /** Real BCrypt, deliberately: a stub encoder would test the mock rather than the matching. */
    private final PasswordEncoder encoder = new BCryptPasswordEncoder();

    private AppUser account;

    @BeforeEach
    void setUp() {
        users = mock(AppUserRepository.class);
        jwt = mock(JwtService.class);
        WebAuthnService webAuthn = mock(WebAuthnService.class);
        OtpService otp = mock(OtpService.class);

        auth = new AuthService(users, encoder, jwt, webAuthn, otp);

        // A Google-created account: username generated from the display name, NOT the email. This
        // is precisely the shape that produced the bug.
        account = new AppUser("adityakhushiyadav", "aditya@example.com",
                              encoder.encode("correct-horse"), "SHAREHOLDER");

        when(jwt.issue(anyString(), anyString(), any())).thenReturn("token");
        when(webAuthn.hasCredentials(any())).thenReturn(false);
        // Default: nothing is found. Each test opens only the lookup it is about, so a test that
        // passes for the wrong reason (finding the user down a path it never exercised) cannot.
        when(users.findByUsername(anyString())).thenReturn(Optional.empty());
        when(users.findByEmail(anyString())).thenReturn(Optional.empty());
    }

    @Test
    void signsInWithTheUsername() {
        when(users.findByUsername("adityakhushiyadav")).thenReturn(Optional.of(account));

        LoginResult result = auth.login(new LoginRequest("adityakhushiyadav", "correct-horse"));

        assertThat(result.status()).isEqualTo("AUTHENTICATED");
        assertThat(result.token()).isEqualTo("token");
    }

    @Test
    void signsInWithTheEmailAddressToo() {
        // The whole point: the address recovery mails a code to also gets you in.
        when(users.findByEmail("aditya@example.com")).thenReturn(Optional.of(account));

        LoginResult result = auth.login(new LoginRequest("aditya@example.com", "correct-horse"));

        assertThat(result.status()).isEqualTo("AUTHENTICATED");
    }

    @Test
    void emailIsMatchedRegardlessOfCaseOrStraySpaces() {
        // Typed by hand on a phone, which capitalises the first letter and adds a trailing space.
        when(users.findByEmail("aditya@example.com")).thenReturn(Optional.of(account));

        LoginResult result = auth.login(new LoginRequest("  Aditya@Example.COM ", "correct-horse"));

        assertThat(result.status()).isEqualTo("AUTHENTICATED");
    }

    @Test
    void aUsernameWinsOverSomebodyElsesEmail() {
        // The field is labelled "username", so if a string is both, read it as the username.
        AppUser other = new AppUser("aditya@example.com", "someone.else@example.com",
                                    encoder.encode("their-password"), "SHAREHOLDER");
        when(users.findByUsername("aditya@example.com")).thenReturn(Optional.of(other));
        when(users.findByEmail("aditya@example.com")).thenReturn(Optional.of(account));

        // Their own password works...
        assertThat(auth.login(new LoginRequest("aditya@example.com", "their-password")).status())
                .isEqualTo("AUTHENTICATED");
        // ...and does not fall through to the other account when it does not.
        assertThatThrownBy(() -> auth.login(new LoginRequest("aditya@example.com", "correct-horse")))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void refusesTheWrongPassword() {
        when(users.findByUsername("adityakhushiyadav")).thenReturn(Optional.of(account));

        assertThatThrownBy(() -> auth.login(new LoginRequest("adityakhushiyadav", "guess")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Invalid username or password");
    }

    @Test
    void refusesAnAccountThatHasNoPasswordYet() {
        // A Google account before any password is set. This must REFUSE, not blow up: passing a
        // null hash into the encoder is not a credential check, it is an accident waiting for the
        // first person who signs up with Google and then tries the password box.
        AppUser passwordless = new AppUser("googler", "g@example.com", null, "SHAREHOLDER");
        when(users.findByUsername("googler")).thenReturn(Optional.of(passwordless));

        assertThatThrownBy(() -> auth.login(new LoginRequest("googler", "anything")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Invalid username or password");
    }

    @Test
    void refusesAnUnknownIdentifierWithoutLeakingWhichPartWasWrong() {
        assertThatThrownBy(() -> auth.login(new LoginRequest("nobody@example.com", "whatever")))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Invalid username or password");
    }

    @Test
    void ignoresBlankInputInsteadOfSearchingForIt() {
        assertThatThrownBy(() -> auth.login(new LoginRequest("   ", "whatever")))
                .isInstanceOf(ResponseStatusException.class);
    }
}
