package com.agmsentinel.config;

import com.agmsentinel.security.RequiresFeature;
import com.agmsentinel.service.FeatureService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Enforces {@link RequiresFeature} on every annotated route.
 *
 * <p>One place, checked for every request, rather than a call at the top of each method. The
 * imperative version fails silently — forget the check and the endpoint stays live with the feature
 * switched off, which is precisely what a flag exists to prevent.
 *
 * <p>Runs after Spring Security, so it can only ever narrow access. A caller already refused by the
 * security rules never reaches here, and being permitted here grants nothing on its own.
 *
 * <p><b>Class and method annotations both apply</b> — they are ANDed, not overridden. A route inside
 * a gated controller that also carries its own annotation needs both features on.
 *
 * <p>That direction is deliberate. The obvious alternative — the method annotation winning — reads
 * naturally but fails open: {@code VotingController} is gated on VOTING and its quorum route adds
 * QUORUM, and with "method wins" that route would stay live with VOTING switched off. A nested
 * feature is a narrowing of its parent, never an escape from it.
 */
@Component
public class FeatureInterceptor implements HandlerInterceptor, WebMvcConfigurer {

    private final FeatureService features;

    public FeatureInterceptor(FeatureService features) {
        this.features = features;
    }

    @Override
    public void addInterceptors(@NonNull InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/**");
    }

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request,
                             @NonNull HttpServletResponse response,
                             @NonNull Object handler) {
        if (!(handler instanceof HandlerMethod method)) return true;

        // getAnnotationsByType, not getAnnotation: RequiresFeature is repeatable, and the plain
        // getter returns null when a route carries two of them — which would silently disable the
        // guard on exactly the routes that asked for the most.
        //
        // Class first, so the failure a caller is told about is the broadest one. Unannotated routes
        // are unaffected: this adds a gate where one is asked for, it does not put everything behind
        // one.
        RequiresFeature[] onClass = method.getBeanType().getAnnotationsByType(RequiresFeature.class);
        RequiresFeature[] onMethod = method.getMethod().getAnnotationsByType(RequiresFeature.class);

        // require() throws a ResponseStatusException, which the standard handling turns into 404
        // (feature disabled — deliberately not 403, since "you may not" confirms it exists) or 403
        // (enabled, but not for this caller's role).
        for (RequiresFeature required : onClass) features.require(required.value());
        for (RequiresFeature required : onMethod) features.require(required.value());
        return true;
    }
}
