package com.agmsentinel;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Proves the {@code APP_LOG_LEVEL} switch is actually wired to this application's loggers.
 *
 * <h2>Why assert something so simple</h2>
 * {@code logging.level.com.agmsentinel: ${APP_LOG_LEVEL:INFO}} looks obviously correct, and a
 * misspelled package or a property Spring never reads looks identical — silently, and only in the
 * direction that matters. A switch believed to control logging but wired to nothing is worse than
 * no switch: someone sets it to quieten a noisy deployment, sees no change, and concludes the
 * logging itself is broken.
 *
 * <p>Set to WARN here so both directions are checked at once: warnings still get through, and the
 * INFO audit trail does not. Booting the real context is the point — this is testing the
 * configuration, not the logging framework.
 */
@SpringBootTest(properties = "APP_LOG_LEVEL=WARN")
@ActiveProfiles("test")
class LogLevelSwitchTest {

    @Test
    void theSwitchRaisesAndLowersThisApplicationsLogging() {
        // Any logger inside the application's package tree, resolved the same way the real classes
        // resolve theirs.
        Logger ours = LoggerFactory.getLogger("com.agmsentinel.service.SomeService");

        assertThat(ours.isWarnEnabled())
                .as("WARN must still be reported — problems are the last thing to silence")
                .isTrue();
        assertThat(ours.isInfoEnabled())
                .as("INFO must be suppressed at WARN, or the switch is not connected to anything")
                .isFalse();
    }

    @Test
    void theSwitchIsScopedToThisApplicationAndNotTheWholeJvm() {
        // Only com.agmsentinel is bound to APP_LOG_LEVEL. Framework loggers keep their own defaults
        // so that raising this to DEBUG surfaces the application's own reasoning rather than
        // burying it under Hibernate and Netty chatter.
        Logger framework = LoggerFactory.getLogger("org.springframework.boot.SomeFrameworkClass");

        assertThat(framework.isInfoEnabled())
                .as("the framework's own level must be untouched by this application's switch")
                .isTrue();
    }
}
