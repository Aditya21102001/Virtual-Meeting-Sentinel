package com.agmsentinel.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.web.bind.annotation.RestController;

import java.lang.reflect.Method;
import java.util.EnumSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Checks that every feature in the catalogue is actually enforced somewhere.
 *
 * <h2>Why this test exists</h2>
 * A flag that appears on the admin screen but guards nothing is worse than no flag at all: an
 * administrator switches it off, the menu entry disappears, and they reasonably conclude the
 * capability is gone — while the endpoints stay open to anyone calling them directly.
 *
 * <p>That is not hypothetical. Seven of the sixteen features were in exactly that state, and it was
 * found by comparing two lists by hand. This test is that comparison, run automatically, so a
 * feature added tomorrow cannot quietly ship without a guard.
 *
 * <p>It deliberately checks only that a guard <em>exists</em>. Whether it guards the right routes is
 * a judgement no test can make.
 */
class FeatureCoverageTest {

    /**
     * Features enforced somewhere other than a controller annotation, with the reason.
     *
     * <p>An allow-list rather than a looser check, so adding one is a deliberate edit that a
     * reviewer sees — the failure this test exists to catch looks exactly like a missing entry here.
     */
    private static final Set<Feature> ENFORCED_ELSEWHERE = EnumSet.of(
            // Checked in VideoProcessingWorker: transcription happens on a background worker after
            // an upload, not on a request, so there is no route to annotate.
            Feature.AUTO_TRANSCRIPTION);

    @Test
    @DisplayName("every feature in the catalogue is enforced somewhere")
    void everyFeatureIsEnforced() {
        Set<Feature> guarded = EnumSet.noneOf(Feature.class);

        ClassPathScanningCandidateComponentProvider scanner =
                new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));

        for (BeanDefinition definition : scanner.findCandidateComponents("com.agmsentinel.controller")) {
            Class<?> controller = loadClass(definition.getBeanClassName());

            // getAnnotationsByType, not getAnnotation — RequiresFeature is repeatable, and the plain
            // getter returns null where two are present. Using it here would make this test report a
            // feature as unguarded precisely where it is guarded twice.
            for (RequiresFeature required : controller.getAnnotationsByType(RequiresFeature.class)) {
                guarded.add(required.value());
            }
            for (Method method : controller.getDeclaredMethods()) {
                for (RequiresFeature required : method.getAnnotationsByType(RequiresFeature.class)) {
                    guarded.add(required.value());
                }
            }
        }

        guarded.addAll(ENFORCED_ELSEWHERE);

        Set<Feature> unguarded = EnumSet.allOf(Feature.class);
        unguarded.removeAll(guarded);

        assertTrue(unguarded.isEmpty(),
                "These features can be switched off in the admin screen but nothing enforces them, "
                + "so turning them off would hide the UI while leaving the endpoints live: "
                + unguarded + ". Add @RequiresFeature to the routes they own, or add the feature to "
                + "ENFORCED_ELSEWHERE with a note saying where it is checked.");
    }

    @Test
    @DisplayName("the catalogue found at least the features we expect")
    void scannerActuallyFoundControllers() {
        // Guards the test itself. If the package moved or the scan silently returned nothing, the
        // check above would pass by finding nothing to contradict it — a green test proving nothing.
        ClassPathScanningCandidateComponentProvider scanner =
                new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));
        int controllers = scanner.findCandidateComponents("com.agmsentinel.controller").size();

        assertTrue(controllers >= 10,
                "Expected to scan the controllers but found " + controllers
                + " — has the package moved? Without them the coverage check above proves nothing.");
    }

    @Test
    @DisplayName("a route may require two features, and both are read")
    void repeatedAnnotationsAreBothVisible() {
        // The reason RequiresFeature is repeatable. Before it was, "needs both" could only be
        // expressed by splitting the two across the class and the method, which made a security
        // property depend on where the code happened to sit.
        Method quorum = findMethod("com.agmsentinel.controller.VotingController", "meetingQuorum");
        RequiresFeature[] required = quorum.getAnnotationsByType(RequiresFeature.class);

        assertEquals(2, required.length,
                "meeting-quorum should state both VOTING and QUORUM directly on the method");
        Set<Feature> features = EnumSet.noneOf(Feature.class);
        for (RequiresFeature r : required) features.add(r.value());
        assertEquals(EnumSet.of(Feature.VOTING, Feature.QUORUM), features);
    }

    private Class<?> loadClass(String name) {
        try {
            return Class.forName(name);
        } catch (ClassNotFoundException ex) {
            throw new AssertionError("Scanned a controller that will not load: " + name, ex);
        }
    }

    private Method findMethod(String className, String methodName) {
        for (Method method : loadClass(className).getDeclaredMethods()) {
            if (method.getName().equals(methodName)) return method;
        }
        throw new AssertionError("No method " + methodName + " on " + className);
    }
}
