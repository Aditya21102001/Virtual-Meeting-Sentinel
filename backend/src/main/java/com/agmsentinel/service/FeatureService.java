package com.agmsentinel.service;

import com.agmsentinel.model.FeatureFlag;
import com.agmsentinel.repository.FeatureFlagRepository;
import com.agmsentinel.security.Feature;
import com.agmsentinel.security.JwtService;
import io.jsonwebtoken.Claims;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Whether a feature is on, and who may use it.
 *
 * <p>Reads are the hot path — every guarded request asks — so the resolved state is held in memory
 * and refreshed on write. A database round trip per request to answer "is this switched on" would
 * make the flag system itself the slowest thing about the features it guards.
 *
 * <p>The store holds only what an admin has changed. Anything without a row behaves as the
 * catalogue default, which is what lets a new feature ship dark without anyone having to insert a
 * row first.
 */
@Service
public class FeatureService {

    private static final Logger log = LoggerFactory.getLogger(FeatureService.class);

    private final FeatureFlagRepository flags;

    /** Resolved state, rebuilt on every write. Volatile map reference, replaced wholesale. */
    private volatile Map<Feature, Resolved> state = Map.of();

    /** One feature's effective configuration. */
    public record Resolved(Feature feature, boolean enabled, Set<String> allowedRoles,
                           String updatedBy, boolean customised) { }

    public FeatureService(FeatureFlagRepository flags) {
        this.flags = flags;
    }

    /**
     * Load the stored overrides once the context is up.
     *
     * <p>Guarded: a feature-flag table that cannot be read must not stop the application starting.
     * Falling back to the catalogue defaults means the app comes up behaving exactly as it would
     * with no overrides — degraded, but running and diagnosable.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void loadOnStartup() {
        try {
            refresh();
            long on = state.values().stream().filter(Resolved::enabled).count();
            log.info("Feature flags loaded: {} of {} enabled.", on, Feature.values().length);
        } catch (RuntimeException ex) {
            log.error("Could not read feature flags; falling back to defaults. {}", ex.getMessage());
            this.state = defaults();
        }
    }

    @Transactional(readOnly = true)
    public void refresh() {
        Map<String, FeatureFlag> stored = new LinkedHashMap<>();
        for (FeatureFlag flag : flags.findAll()) {
            stored.put(flag.getKey().toUpperCase(), flag);
        }
        Map<Feature, Resolved> resolved = new LinkedHashMap<>();
        for (Feature feature : Feature.values()) {
            FeatureFlag flag = stored.get(feature.key());
            if (flag == null) {
                resolved.put(feature, new Resolved(feature, feature.enabledByDefault(),
                        feature.defaultRoles(), null, false));
            } else {
                Set<String> roles = flag.getAllowedRoles().isEmpty()
                        ? feature.defaultRoles() : Set.copyOf(flag.getAllowedRoles());
                resolved.put(feature, new Resolved(feature, flag.isEnabled(), roles,
                        flag.getUpdatedBy(), true));
            }
        }
        this.state = resolved;
    }

    private Map<Feature, Resolved> defaults() {
        Map<Feature, Resolved> map = new LinkedHashMap<>();
        for (Feature feature : Feature.values()) {
            map.put(feature, new Resolved(feature, feature.enabledByDefault(),
                    feature.defaultRoles(), null, false));
        }
        return map;
    }

    private Resolved resolve(Feature feature) {
        Resolved current = state.get(feature);
        if (current != null) return current;
        // Asked before startup finished, or for a feature added since the last refresh.
        return new Resolved(feature, feature.enabledByDefault(), feature.defaultRoles(), null, false);
    }

    // ---- asking --------------------------------------------------------------

    public boolean isEnabled(Feature feature) {
        return resolve(feature).enabled();
    }

    /** Enabled, and permitted for at least one role this caller holds. */
    public boolean isAvailableTo(Feature feature, Set<String> roles) {
        Resolved resolved = resolve(feature);
        if (!resolved.enabled()) return false;
        // ADMIN is a superset throughout the application; a switched-on feature is never hidden
        // from the person who administers the switches.
        if (roles.contains("ADMIN")) return true;
        return resolved.allowedRoles().stream().anyMatch(roles::contains);
    }

    /** Every feature, with its effective state — what the admin screen renders. */
    public List<Resolved> all() {
        return Feature.values().length == state.size()
                ? List.copyOf(state.values())
                : List.copyOf(defaults().values());
    }

    /** The subset available to the current caller — what the SPA uses to decide what to show. */
    public List<Feature> availableToCurrentUser() {
        Set<String> roles = currentRoles();
        return java.util.Arrays.stream(Feature.values())
                .filter(f -> isAvailableTo(f, roles))
                .toList();
    }

    /**
     * Refuse the request when the feature is off or not permitted for this caller.
     *
     * <p>404 rather than 403 when it is switched off. A disabled feature should not be discoverable
     * by probing — "you are not allowed" confirms it exists, which is a different statement from
     * "there is nothing here".
     */
    public void require(Feature feature) {
        Resolved resolved = resolve(feature);
        if (!resolved.enabled()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "That feature is not enabled on this deployment.");
        }
        if (!isAvailableTo(feature, currentRoles())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Your role does not have access to " + feature.label() + ".");
        }
    }

    // ---- changing ------------------------------------------------------------

    /**
     * Turn a feature on or off, and optionally narrow which roles may use it.
     *
     * <p><b>Null and empty mean different things.</b> Null is "I am not changing the roles" — the
     * caller is only flipping the switch — and keeps whatever is already configured. Empty is an
     * explicit "no role may use this", and is stored as such.
     *
     * <p>They were once treated the same, both falling back to the catalogue defaults. That made
     * unticking the last role silently re-tick every default one, which reads as the screen undoing
     * the click. An admin narrowing a feature to nothing has said something deliberate, and the
     * honest response is to store it — the feature is then effectively off for everyone but ADMIN,
     * which is exactly what they asked for and is visible on the screen.
     */
    @Transactional
    public Resolved update(Feature feature, boolean enabled, Set<String> allowedRoles, String actor) {
        Set<String> roles = allowedRoles == null
                ? resolve(feature).allowedRoles()
                : Set.copyOf(allowedRoles);

        FeatureFlag flag = flags.findById(feature.key()).orElse(null);
        if (flag == null) {
            flag = new FeatureFlag(feature.key(), enabled, roles, actor);
        } else {
            flag.setEnabled(enabled);
            flag.setAllowedRoles(roles);
            flag.setUpdatedBy(actor);
        }
        flags.save(flag);
        refresh();
        log.info("Feature {} {} by {} (roles: {}).", feature.key(),
                 enabled ? "enabled" : "disabled", actor, roles);
        return resolve(feature);
    }

    /**
     * Apply one decision to every feature at once.
     *
     * <p>Exists because configuring sixteen features one switch at a time is the common case for a
     * fresh deployment — "turn everything on for everyone" is a setup step, not a fine adjustment,
     * and doing it by hand invites missing one.
     *
     * <p><b>Granting every role cannot escalate anything.</b> Roles on a feature narrow access; they
     * never widen it, because {@code SecurityConfig} is checked first and independently. A
     * shareholder listed against a moderator-only route still gets a 403 from Spring Security. That
     * is what makes a blunt bulk action safe to offer.
     *
     * <p>Written as one transaction and one refresh, so the cached state is never half-applied.
     *
     * @param roles null to leave each feature's roles as they are — see {@link #update}
     */
    @Transactional
    public List<Resolved> updateAll(boolean enabled, Set<String> roles, String actor) {
        for (Feature feature : Feature.values()) {
            Set<String> effective = roles == null ? resolve(feature).allowedRoles() : Set.copyOf(roles);
            FeatureFlag flag = flags.findById(feature.key()).orElse(null);
            if (flag == null) {
                flag = new FeatureFlag(feature.key(), enabled, effective, actor);
            } else {
                flag.setEnabled(enabled);
                flag.setAllowedRoles(effective);
                flag.setUpdatedBy(actor);
            }
            flags.save(flag);
        }
        refresh();
        log.warn("ALL {} features {} by {}{}.", Feature.values().length,
                 enabled ? "enabled" : "disabled", actor,
                 roles == null ? "" : " for roles " + roles);
        return all();
    }

    /**
     * Drop every override, returning the whole deployment to how it ships.
     *
     * <p>The way back from a bulk change that went too far, and the reason
     * {@link #updateAll} is safe to press.
     */
    @Transactional
    public List<Resolved> resetAll(String actor) {
        flags.deleteAll();
        refresh();
        log.warn("All feature overrides cleared by {} — every feature is back to its default.", actor);
        return all();
    }

    /** Drop the override so the feature returns to its catalogue default. */
    @Transactional
    public Resolved reset(Feature feature, String actor) {
        flags.findById(feature.key()).ifPresent(flags::delete);
        refresh();
        log.info("Feature {} reset to its default by {}.", feature.key(), actor);
        return resolve(feature);
    }

    // ---- caller ---------------------------------------------------------------

    /**
     * Every role the caller holds.
     *
     * <p>Read from the verified token's claims where available, falling back to granted authorities.
     * Both describe the same thing; the claims are simply closer to the source.
     */
    private Set<String> currentRoles() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null) return Set.of();
        if (auth.getCredentials() instanceof Claims claims) {
            return Set.copyOf(JwtService.rolesOf(claims));
        }
        return auth.getAuthorities().stream()
                .map(a -> a.getAuthority())
                .map(a -> a.startsWith("ROLE_") ? a.substring(5) : a)
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
    }

    public Optional<Feature> lookup(String key) {
        return Feature.of(key);
    }
}
