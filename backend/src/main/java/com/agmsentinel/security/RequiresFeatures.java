package com.agmsentinel.security;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Container for repeated {@link RequiresFeature} annotations.
 *
 * <p>Required by the language: {@code @Repeatable} needs a holder to collect the repeats into. It is
 * not written by hand — writing {@code @RequiresFeature(A) @RequiresFeature(B)} produces one of
 * these automatically.
 *
 * <p>Every listed feature must be enabled for the route to be reachable. They are ANDed, never
 * ORed: a route guarded by two features is a route that needs both, and treating the list as
 * alternatives would make adding a second guard <em>weaken</em> the first.
 */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequiresFeatures {
    RequiresFeature[] value();
}
