package com.agmsentinel.security;

import java.lang.annotation.ElementType;
import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a route as belonging to a switchable feature.
 *
 * <p>Declarative rather than a call at the top of every method, because the failure mode of the
 * imperative version is silent: forget the check and the endpoint stays reachable with the feature
 * off, which is the one thing a feature flag exists to prevent. An annotation is visible in review
 * and enforced in one place ({@code FeatureInterceptor}).
 *
 * <p>Enforcement runs <em>after</em> Spring Security, so it narrows access and never widens it. A
 * caller who could not reach the route before still cannot.
 *
 * <h2>Repeatable: a route may need more than one feature</h2>
 * Some routes genuinely belong to two features at once — a quorum panel needs both voting and quorum
 * switched on; the semantic search endpoint exists to serve the help widget. All of them must be
 * enabled for the route to be reachable.
 *
 * <p>Before this was repeatable, "needs both" could only be expressed by putting one annotation on
 * the class and the other on the method, which made a security property depend on where a piece of
 * code happened to sit. Two annotations side by side say it directly.
 *
 * <p>Class-level and method-level annotations still combine, and also with each other — everything
 * found is required. See {@code FeatureInterceptor}.
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Repeatable(RequiresFeatures.class)
public @interface RequiresFeature {
    Feature value();
}
