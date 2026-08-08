package com.agmsentinel;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.ActiveProfiles;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Asserts that the application actually starts.
 *
 * <h2>Why this was missing, and why that mattered</h2>
 * Every other test here is a unit test or a {@code @DataJpaTest} slice. None of them builds the
 * bean graph, so a green {@code mvn test} said nothing at all about whether the application would
 * come up: a missing bean, a constructor that no longer matches, a circular dependency or a broken
 * {@code @Configuration} would sail past the whole suite and fail on startup.
 *
 * <p>That is exactly what happened. A run of new beans and rewired constructors went in with the
 * suite passing throughout, and the first thing to discover the problem was the running
 * application.
 *
 * <p>This test is deliberately almost empty. Its value is entirely in the {@code @SpringBootTest}
 * annotation — refreshing the context IS the assertion, and it fails with the real reason
 * (`UnsatisfiedDependencyException`, `BeanCurrentlyInCreationException`, and so on) rather than a
 * message this file would have to invent.
 *
 * <p>The explicit bean checks below cover the wiring most likely to break silently: services whose
 * constructors changed to take new collaborators, and configuration that only exists to be
 * injected somewhere else.
 */
@SpringBootTest
@ActiveProfiles("test")
class ApplicationContextLoadsTest {

    @Autowired
    private ApplicationContext context;

    @Test
    @DisplayName("the Spring context loads")
    void contextLoads() {
        assertNotNull(context, "the application context should have been built");
    }

    @Test
    @DisplayName("every rewired service is constructible")
    void servicesAreWired() {
        // Named explicitly rather than counted: these are the ones whose constructors gained a
        // collaborator recently, which is precisely the change that compiles and then fails to
        // start when the collaborator is not a bean.
        for (String type : new String[] {
                "com.agmsentinel.service.MeetingScope",
                "com.agmsentinel.service.MeetingService",
                "com.agmsentinel.service.MeetingBackfillService",
                "com.agmsentinel.service.QuestionService",
                "com.agmsentinel.service.ClusterDraftService",
                "com.agmsentinel.service.ClusterDraftWorker",
                "com.agmsentinel.service.ClusterCurationService",
                "com.agmsentinel.service.ChatService",
                "com.agmsentinel.service.VotingService",
                "com.agmsentinel.service.RunOfShowService",
                "com.agmsentinel.service.MeetingReportService",
                "com.agmsentinel.service.FeatureService",
                "com.agmsentinel.service.AiClient",
        }) {
            assertBeanPresent(type);
        }
    }

    @Test
    @DisplayName("every controller is constructible")
    void controllersAreWired() {
        // A controller that cannot be built takes the whole context down, so this overlaps with
        // contextLoads — but it names the culprit, which a bare refresh failure does not.
        for (String type : new String[] {
                "com.agmsentinel.controller.MeetingController",
                "com.agmsentinel.controller.VotingController",
                "com.agmsentinel.controller.MeetingReportController",
                "com.agmsentinel.controller.RunOfShowController",
                "com.agmsentinel.controller.ClusterController",
                "com.agmsentinel.controller.FeatureController",
                "com.agmsentinel.controller.AdminController",
                "com.agmsentinel.controller.ChatController",
                "com.agmsentinel.controller.HealthController",
        }) {
            assertBeanPresent(type);
        }
    }

    private void assertBeanPresent(String className) {
        try {
            assertNotNull(context.getBean(Class.forName(className)),
                    className + " should be a bean");
        } catch (ClassNotFoundException ex) {
            throw new AssertionError("Class not on the classpath: " + className, ex);
        }
    }

    @Test
    @DisplayName("the AI service HTTP connector is configured rather than defaulted")
    void aiConnectorIsConfigured() {
        // AiWebClientConfig exists solely to replace reactor-netty's global defaults, which have no
        // idle eviction and no connect timeout. If the bean is absent, AiClient silently falls back
        // to those defaults and the intermittent connection failures return.
        assertTrue(context.getBeanNamesForType(
                        org.springframework.http.client.reactive.ReactorClientHttpConnector.class).length > 0,
                "the AI service connector bean should exist — see AiWebClientConfig");
    }
}
