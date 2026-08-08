package com.agmsentinel.model;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

/**
 * An admin's decision about one feature: whether it is on, and which roles may use it.
 *
 * <p>Stores only the decision. What a feature <em>is</em> — its name, description and defaults —
 * lives in {@code Feature}, so a row here is a small override rather than a duplicate of the
 * catalogue. A feature with no row simply behaves as its default.
 *
 * <p>Keyed by the enum name rather than a generated id: the key is already unique, already stable,
 * and makes the table readable when somebody inspects it during an incident.
 */
@Entity
@Table(name = "feature_flags")
public class FeatureFlag {

    @Id
    @Column(name = "feature_key", length = 64)
    private String key;

    @Column(nullable = false)
    private boolean enabled;

    /**
     * Roles permitted to use this feature.
     *
     * <p>A ceiling, never a grant: {@code SecurityConfig} is checked first and independently, so
     * adding a role here cannot let anyone reach something they could not reach before.
     */
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "feature_flag_roles",
                     joinColumns = @JoinColumn(name = "feature_key"),
                     uniqueConstraints = @UniqueConstraint(columnNames = {"feature_key", "role"}))
    @Column(name = "role", nullable = false, length = 32)
    private Set<String> allowedRoles = new HashSet<>();

    @Column(name = "updated_by")
    private String updatedBy;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    protected FeatureFlag() { }

    public FeatureFlag(String key, boolean enabled, Set<String> allowedRoles, String updatedBy) {
        this.key = key;
        this.enabled = enabled;
        this.allowedRoles = new HashSet<>(allowedRoles);
        this.updatedBy = updatedBy;
    }

    @PreUpdate
    void touch() {
        this.updatedAt = Instant.now();
    }

    public String getKey() { return key; }
    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public Set<String> getAllowedRoles() { return allowedRoles; }
    public void setAllowedRoles(Set<String> allowedRoles) {
        this.allowedRoles = allowedRoles == null ? new HashSet<>() : new HashSet<>(allowedRoles);
    }
    public String getUpdatedBy() { return updatedBy; }
    public void setUpdatedBy(String updatedBy) { this.updatedBy = updatedBy; }
    public Instant getUpdatedAt() { return updatedAt; }
}
