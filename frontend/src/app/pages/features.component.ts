import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FeatureService, FeatureView } from '../services/feature.service';

/**
 * Switch features on and off, and choose which roles may use them. ADMIN only.
 *
 * <p>The list populates itself from the backend catalogue, so a feature added in code appears here
 * with no change to this screen.
 *
 * <p>Two things are shown that a plain on/off toggle would hide: whether a feature is still on its
 * shipped default, and who last changed it. Both matter when somebody is working out why a
 * capability is missing — "nobody has touched this" and "an admin turned it off on Tuesday" are very
 * different answers to the same question.
 *
 * <h2>Why the switches are checkboxes underneath</h2>
 * They look like sliders but they are real {@code <input type="checkbox">} elements, visually
 * restyled. A div with a click handler would have looked identical and been wrong: a switch has to
 * be reachable by keyboard, announce itself as a checkbox, and report its own checked state. Using
 * the real control gives all three rather than reimplementing them.
 */
@Component({
  selector: 'app-features',
  standalone: true,
  template: `
    <div class="container features-page">
      <header class="page-head">
        <h1>Features</h1>
        <p class="muted sub">
          Turn capabilities on or off for this deployment, and narrow which roles may use them.
          Roles here are a ceiling, never a grant — a role that could not reach something before
          still cannot.
        </p>
      </header>

      @if (error()) {
        <div class="error-box" role="alert">{{ error() }}</div>
      }

      @if (loading()) {
        <div class="card"><span class="muted">Loading…</span></div>
      } @else if (features().length) {
        <div class="card summary">
          <p class="count" role="status">
            <strong>{{ onCount() }}</strong> of {{ features().length }} features on ·
            <strong>{{ customisedCount() }}</strong> changed from the shipped default
          </p>
          <div class="bulk">
            <button (click)="enableEverything()" [disabled]="bulkBusy()">
              Turn everything on, for every role
            </button>
            <button class="ghost" (click)="disableEverything()" [disabled]="bulkBusy()">
              Turn everything off
            </button>
            <button class="link" (click)="resetEverything()" [disabled]="bulkBusy()">
              Reset all to shipped defaults
            </button>
          </div>
          <p class="muted small">
            Granting every role cannot let anyone reach something they could not before — roles
            narrow access, they never widen it. “Reset all” is the way back.
          </p>
        </div>
      }

      @for (f of features(); track f.key) {
        <section class="card feature" [class.off]="!f.enabled">
          <div class="feature-head">
            <!-- The switch. A real checkbox, restyled — see the class note. -->
            <label class="switch" [class.busy]="busy() === f.key">
              <input
                type="checkbox"
                [checked]="f.enabled"
                [disabled]="busy() === f.key"
                (change)="toggle(f, $any($event.target).checked)"
                [attr.aria-describedby]="descId(f)"
              />
              <span class="track" aria-hidden="true"><span class="knob"></span></span>
              <span class="switch-label">{{ f.label }}</span>
            </label>

            <div class="meta">
              @if (!f.customised) {
                <span class="badge" title="Nobody has changed this">default</span>
              } @else {
                <span class="badge changed">changed</span>
                @if (f.updatedBy) {
                  <span class="muted-inline">by {{ f.updatedBy }}</span>
                }
                <button class="link" (click)="reset(f)" [disabled]="busy() === f.key">
                  Reset to {{ f.enabledByDefault ? 'on' : 'off' }}
                </button>
              }
            </div>
          </div>

          <p class="muted desc" [id]="descId(f)">{{ f.description }}</p>

          <fieldset class="roles" [disabled]="busy() === f.key || !f.enabled">
            <legend class="roles-legend">
              Available to
              @if (!f.enabled) {
                <span class="muted-inline">— switch the feature on to change this</span>
              }
            </legend>
            <div class="role-list">
              @for (role of roles(); track role) {
                <label class="chip" [class.on]="f.allowedRoles.includes(role)">
                  <input
                    type="checkbox"
                    [checked]="f.allowedRoles.includes(role)"
                    (change)="toggleRole(f, role, $any($event.target).checked)"
                  />
                  <span>{{ role }}</span>
                </label>
              }
            </div>
            @if (f.enabled && !f.allowedRoles.length) {
              <p class="warn" role="status">
                No role can use this. It is on, but only an admin will see it.
              </p>
            }
          </fieldset>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page-head h1 {
        margin-bottom: 4px;
      }
      .sub {
        margin: 0;
        max-width: 68ch;
      }
      .summary .count {
        margin: 0 0 10px;
        font-size: 13px;
      }
      .bulk {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .small {
        font-size: 12px;
        margin: 10px 0 0;
        max-width: 72ch;
      }

      .feature.off {
        opacity: 0.82;
      }
      .feature-head {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-left: auto;
      }
      .badge.changed {
        background: #0369a1;
        color: #e0f2fe;
      }

      /* ---- the switch ---- */
      .switch {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        min-width: 0;
      }
      .switch.busy {
        opacity: 0.6;
      }
      /* The real control: off-screen but focusable and still announced. Not display:none, which
         would take it out of the accessibility tree and off the tab order entirely. */
      .switch input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
      }
      .track {
        flex: 0 0 auto;
        width: 42px;
        height: 24px;
        border-radius: 999px;
        background: #334155;
        position: relative;
        transition: background 0.18s ease;
      }
      .knob {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #94a3b8;
        transition: transform 0.18s ease, background 0.18s ease;
      }
      .switch input:checked + .track {
        background: var(--accent);
      }
      .switch input:checked + .track .knob {
        transform: translateX(18px);
        background: #04222f;
      }
      /* Focus lands on the visible track, since the input itself is off-screen. */
      .switch input:focus-visible + .track {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
      }
      .switch-label {
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .desc {
        margin: 10px 0 12px;
        max-width: 72ch;
      }

      /* ---- roles ---- */
      .roles {
        border: 0;
        margin: 0;
        padding: 0;
        min-width: 0;
      }
      .roles[disabled] {
        opacity: 0.5;
      }
      .roles-legend {
        font-size: 13px;
        color: var(--muted);
        padding: 0;
        margin-bottom: 8px;
      }
      .role-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid #334155;
        font-size: 13px;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
      }
      .chip.on {
        border-color: var(--accent);
        background: rgba(56, 189, 248, 0.12);
      }
      .roles:not([disabled]) .chip:hover {
        border-color: var(--accent);
      }
      .chip:focus-within {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .warn {
        margin: 10px 0 0;
        font-size: 13px;
        color: var(--hot);
      }

      @media (max-width: 640px) {
        .meta {
          margin-left: 0;
          width: 100%;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .track,
        .knob,
        .chip {
          transition: none;
        }
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

  readonly onCount = computed(() => this.features().filter((f) => f.enabled).length);
  readonly customisedCount = computed(() => this.features().filter((f) => f.customised).length);

  /** Ties each switch to its description for screen readers. */
  descId(f: FeatureView): string {
    return `feat-desc-${f.key.toLowerCase()}`;
  }

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

  /**
   * Flip the switch.
   *
   * <p>Sends no role list at all, rather than echoing the current one. The server reads null as "not
   * changing the roles" — echoing them back would make a simple on/off also rewrite the role
   * configuration, which is a second change the admin did not ask for.
   */
  toggle(feature: FeatureView, enabled: boolean): void {
    this.write(feature, enabled, null);
  }

  toggleRole(feature: FeatureView, role: string, granted: boolean): void {
    const roles = granted
      ? [...feature.allowedRoles, role]
      : feature.allowedRoles.filter((r) => r !== role);
    this.write(feature, feature.enabled, roles);
  }

  private write(feature: FeatureView, enabled: boolean, roles: string[] | null): void {
    this.busy.set(feature.key);
    this.error.set('');
    this.service.set(feature.key, enabled, roles).subscribe({
      next: (updated) => {
        this.busy.set(null);
        // Patch in place rather than reloading: a full refresh would scroll the admin away from
        // the row they just clicked.
        this.features.update((list) => list.map((f) => (f.key === updated.key ? updated : f)));
      },
      error: () => {
        this.busy.set(null);
        this.error.set(`Could not update ${feature.label}.`);
        this.load(); // resync, so the switch does not lie about the stored state
      },
    });
  }

  // ---- bulk actions ---------------------------------------------------------
  //
  // Configuring sixteen features one switch at a time is the common case for a fresh deployment.
  // Each is confirmed: they change the whole application at once, and "turn everything on" in
  // particular switches on capabilities that ship off deliberately.

  readonly bulkBusy = signal(false);

  enableEverything(): void {
    if (
      !confirm(
        'Turn on every feature, for every role?\n\n' +
          'This includes features that ship switched off. Roles cannot grant access beyond what ' +
          'each role already has, but the capabilities themselves become live immediately.',
      )
    ) {
      return;
    }
    this.bulk(this.service.setAll(true, this.roles()));
  }

  disableEverything(): void {
    if (
      !confirm(
        'Turn off every feature?\n\n' +
          'This includes the ones that ship on — recordings, the Lounge, likes and comments, and ' +
          'AI drafting will all stop working for everyone until they are switched back on.',
      )
    ) {
      return;
    }
    // Roles are left alone, so switching everything back on later restores the configuration
    // rather than flattening it to the defaults.
    this.bulk(this.service.setAll(false, null));
  }

  resetEverything(): void {
    if (!confirm('Discard every change and return all features to how they ship?')) return;
    this.bulk(this.service.resetAll());
  }

  private bulk(call: ReturnType<FeatureService['resetAll']>): void {
    this.bulkBusy.set(true);
    this.error.set('');
    call.subscribe({
      next: (list) => {
        this.bulkBusy.set(false);
        this.features.set(list);
      },
      error: () => {
        this.bulkBusy.set(false);
        this.error.set('Could not apply that to every feature. Nothing was changed.');
        this.load();
      },
    });
  }

  reset(feature: FeatureView): void {
    this.busy.set(feature.key);
    this.service.reset(feature.key).subscribe({
      next: (updated) => {
        this.busy.set(null);
        this.features.update((list) => list.map((f) => (f.key === updated.key ? updated : f)));
      },
      error: () => {
        this.busy.set(null);
        this.error.set(`Could not reset ${feature.label}.`);
      },
    });
  }
}
