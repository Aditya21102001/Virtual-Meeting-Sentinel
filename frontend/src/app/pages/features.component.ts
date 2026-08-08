import { Component, OnInit, inject, signal } from '@angular/core';
import { FeatureService, FeatureView } from '../services/feature.service';

/**
 * Switch features on and off, and choose which roles may use them. ADMIN only.
 *
 * <p>The list populates itself from the backend catalogue, so a feature added in code appears here
 * with no change to this screen.
 *
 * <p>Two things are shown that a plain on/off toggle would hide: whether a feature is still on its
 * shipped default, and who last changed it. Both matter when somebody is trying to work out why a
 * capability is missing — "nobody has touched this" and "an admin turned it off on Tuesday" are very
 * different answers to the same question.
 */
@Component({
  selector: 'app-features',
  standalone: true,
  template: `
    <div class="container">
      <h1>Features</h1>
      <p class="muted">
        Turn capabilities on or off for this deployment, and narrow which roles may use them.
        Roles here are a ceiling, never a grant — a role that could not reach something before
        still cannot.
      </p>

      @if (error()) {
        <div class="error-box">{{ error() }}</div>
      }
      @if (loading()) {
        <div class="card"><span class="muted">Loading…</span></div>
      }

      @for (f of features(); track f.key) {
        <div class="card">
          <div class="row">
            <label class="toggle">
              <input
                type="checkbox"
                [checked]="f.enabled"
                [disabled]="busy() === f.key"
                (change)="toggle(f, $any($event.target).checked)"
              />
              <strong>{{ f.label }}</strong>
            </label>
            @if (!f.customised) {
              <span class="badge">default</span>
            } @else if (f.updatedBy) {
              <span class="muted-inline">changed by {{ f.updatedBy }}</span>
            }
            <span style="flex:1"></span>
            @if (f.customised) {
              <button class="link" (click)="reset(f)" [disabled]="busy() === f.key">
                Reset to default ({{ f.enabledByDefault ? 'on' : 'off' }})
              </button>
            }
          </div>

          <p class="muted desc">{{ f.description }}</p>

          <div class="roles">
            <span class="muted-inline">Available to:</span>
            @for (role of roles(); track role) {
              <label class="role">
                <input
                  type="checkbox"
                  [checked]="f.allowedRoles.includes(role)"
                  [disabled]="busy() === f.key || !f.enabled"
                  (change)="toggleRole(f, role, $any($event.target).checked)"
                />
                {{ role }}
              </label>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toggle,
      .role {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .desc {
        margin: 6px 0 8px;
      }
      .roles {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 13px;
      }
    `,
  ],
})
export class FeaturesComponent implements OnInit {
  private readonly service = inject(FeatureService);

  readonly features = signal<FeatureView[]>([]);
  readonly roles = signal<string[]>([]);
  readonly loading = signal(true);
  /** The key currently being written, so only that row disables. */
  readonly busy = signal<string | null>(null);
  readonly error = signal('');

  ngOnInit(): void {
    this.service.assignableRoles().subscribe({
      next: (roles) => this.roles.set(roles),
      error: () => {},
    });
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.service.list().subscribe({
      next: (list) => {
        this.features.set(list);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(
          err?.status === 403
            ? 'Only an admin can change features.'
            : 'Could not load the feature list.',
        );
      },
    });
  }

  toggle(feature: FeatureView, enabled: boolean): void {
    this.write(feature, enabled, feature.allowedRoles);
  }

  toggleRole(feature: FeatureView, role: string, granted: boolean): void {
    const roles = granted
      ? [...feature.allowedRoles, role]
      : feature.allowedRoles.filter((r) => r !== role);
    this.write(feature, feature.enabled, roles);
  }

  private write(feature: FeatureView, enabled: boolean, roles: string[]): void {
    this.busy.set(feature.key);
    this.error.set('');
    this.service.set(feature.key, enabled, roles).subscribe({
      next: (updated) => {
        this.busy.set(null);
        // Patch in place rather than reloading: a full refresh would scroll the admin away from
        // the row they just clicked.
        this.features.update((list) =>
          list.map((f) => (f.key === updated.key ? updated : f)),
        );
      },
      error: () => {
        this.busy.set(null);
        this.error.set(`Could not update ${feature.label}.`);
        this.load();   // resync, so the checkbox does not lie about the stored state
      },
    });
  }

  reset(feature: FeatureView): void {
    this.busy.set(feature.key);
    this.service.reset(feature.key).subscribe({
      next: (updated) => {
        this.busy.set(null);
        this.features.update((list) =>
          list.map((f) => (f.key === updated.key ? updated : f)),
        );
      },
      error: () => {
        this.busy.set(null);
        this.error.set(`Could not reset ${feature.label}.`);
      },
    });
  }
}
