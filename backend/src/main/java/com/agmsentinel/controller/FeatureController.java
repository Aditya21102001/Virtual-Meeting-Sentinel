package com.agmsentinel.controller;

import com.agmsentinel.security.Feature;
import com.agmsentinel.security.Roles;
import com.agmsentinel.service.FeatureService;
import com.agmsentinel.service.FeatureService.Resolved;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Set;

/**
 * Turning features on and off, and choosing which roles may use them.
 *
 * <p>Two audiences. {@code my-features} is for every signed-in user: the SPA asks what it is allowed
 * to show, so a disabled feature leaves no dead menu entry behind. Everything else is ADMIN's —
 * changing what a deployment can do is administration, not moderation.
 *
 * <p>The catalogue lives in {@code Feature}, so this screen populates itself as features are added.
 */
@RestController
@RequestMapping("/api/features")
public class FeatureController {

    private final FeatureService features;

    public FeatureController(FeatureService features) {
        this.features = features;
    }

    /** One feature as the admin screen renders it. */
    public record FeatureView(
            String key,
            String label,
            String description,
            boolean enabled,
            Set<String> allowedRoles,
            /** False when it is still on its catalogue default — nobody has touched it. */
            boolean customised,
            boolean enabledByDefault,
            String updatedBy) {

        static FeatureView of(Resolved resolved) {
            return new FeatureView(
                    resolved.feature().key(), resolved.feature().label(),
                    resolved.feature().description(), resolved.enabled(),
                    resolved.allowedRoles(), resolved.customised(),
                    resolved.feature().enabledByDefault(), resolved.updatedBy());
        }
    }

    /**
     * {@code allowedRoles} null means "leave the roles alone" — an on/off flip should not also
     * rewrite the role configuration. Empty means "no role", explicitly, and is stored as such.
     */
    public record UpdateFeatureRequest(String key, boolean enabled, Set<String> allowedRoles) { }

    public record FeatureRef(String key) { }

    /** Applies one decision to every feature. {@code allowedRoles} follows the same null rule. */
    public record BulkUpdateRequest(boolean enabled, Set<String> allowedRoles) { }

    /**
     * What this caller may use. Any signed-in user.
     *
     * <p>Keys only: the SPA needs to know what to render, not who else can see it. The full
     * configuration is administration detail.
     */
    @PostMapping("/my-features")
    public List<String> myFeatures() {
        return features.availableToCurrentUser().stream().map(Feature::key).toList();
    }

    /** Every feature with its effective state — the admin screen. */
    @PostMapping("/list-features")
    public List<FeatureView> listFeatures() {
        return features.all().stream().map(FeatureView::of).toList();
    }

    /** The roles a feature may be granted to, so the screen can render the choices. */
    @PostMapping("/assignable-roles")
    public List<String> assignableRoles() {
        return List.of(Roles.ADMIN, Roles.MODERATOR, Roles.SHAREHOLDER, Roles.ATTENDEE,
                       Roles.MEETING_MANAGER, Roles.USER_MANAGER);
    }

    @PostMapping("/set-feature")
    public FeatureView setFeature(@RequestBody UpdateFeatureRequest req) {
        Feature feature = lookup(req.key());
        return FeatureView.of(
                features.update(feature, req.enabled(), req.allowedRoles(), currentSubject()));
    }

    /**
     * Apply one decision to every feature at once — the setup step for a fresh deployment.
     *
     * <p>Granting every role to everything cannot escalate anything: roles on a feature narrow
     * access and never widen it, because Spring Security is checked first and independently. That is
     * what makes a control this blunt safe to offer, and {@code reset-all-features} is the way back.
     */
    @PostMapping("/set-all-features")
    public List<FeatureView> setAllFeatures(@RequestBody BulkUpdateRequest req) {
        return features.updateAll(req.enabled(), req.allowedRoles(), currentSubject())
                .stream().map(FeatureView::of).toList();
    }

    /** Clear every override, returning the whole deployment to how it ships. */
    @PostMapping("/reset-all-features")
    public List<FeatureView> resetAllFeatures() {
        return features.resetAll(currentSubject()).stream().map(FeatureView::of).toList();
    }

    /** Drop the override, returning the feature to how it ships. */
    @PostMapping("/reset-feature")
    public FeatureView resetFeature(@RequestBody FeatureRef req) {
        return FeatureView.of(features.reset(lookup(req.key()), currentSubject()));
    }

    private Feature lookup(String key) {
        return Feature.of(key).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.BAD_REQUEST, "No such feature: " + key));
    }

    private String currentSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? "system" : String.valueOf(auth.getName());
    }
}
