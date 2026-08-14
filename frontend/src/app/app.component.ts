import {
  Component,
  HostListener,
  computed,
  effect,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import {
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
  Router,
  NavigationError,
} from "@angular/router";
import { HelpWidgetComponent } from "./components/help-widget.component";
import { VideoPlayerComponent } from "./components/video-player.component";
import { PlayerHostService } from "./services/player-host.service";
import { AuthService } from "./services/auth.service";
import { FeatureService } from "./services/feature.service";
import { LoadingService } from "./services/loading.service";
import { MeetingService } from "./services/meeting.service";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, HelpWidgetComponent, VideoPlayerComponent],
  template: `
    <!--
      First thing in the tab order and invisible until focused. Without it a keyboard user tabs
      through every navigation link on every page before reaching the content.
    -->
    <!--
      One indicator for the whole application. Individual screens have their own spinners, but
      nothing covered the gaps between them — a slow navigation, a request fired from a service,
      the first call after a cold start — and during those the page simply looked frozen.

      aria-hidden: this is decoration. It duplicates no information, and a screen reader announcing
      "loading" on every request would be far more disruptive than useful. Screens that need to
      announce a wait do so themselves with role="status".
    -->
    @if (loading.visible()) {
      <div class="loading-bar" aria-hidden="true"><span></span></div>
      <!--
        Blocks interaction while a request the user is waiting on is outstanding, so a form cannot
        be submitted twice and a stale screen cannot be acted on.

        Only ever raised by NON-SILENT requests. Every poll and the session renewer are marked
        silent, so a background refresh can never take the interface away from somebody — an
        overlay that appears on a timer would be far worse than no overlay.

        It also releases itself unconditionally after 20 seconds, whatever the request count says.
        See MAX_BLOCK_MS: a stuck blocker is an unusable application, and no indicator is worth
        that.
      -->
      <div class="blocking-overlay" role="alert" aria-live="assertive" aria-busy="true">
        <div class="blocking-card">
          <span class="blocking-spinner" aria-hidden="true"></span>
          <span>Working…</span>
        </div>
      </div>
    }
    <a class="skip-link" href="#main">Skip to main content</a>
    <nav class="nav" aria-label="Main">
      <div class="nav-bar">
        <a class="brand" routerLink="/ask" (click)="close()"
          >🛡️ VIRTUAL MEETING Sentinel</a
        >

        <!--
          Which meeting is live. Everything on every other screen belongs to it — the questions,
          the board, the ballot — so the answer to "am I looking at the right meeting" should be
          on screen rather than a page away. role="status" so a change is announced rather than
          only noticed.
        -->
        @if (features.enabled("MEETINGS")) {
          @if (meetings.active(); as live) {
            <span class="live-meeting" role="status">
              <span class="live-dot" aria-hidden="true"></span>
              <span class="live-label">
                <span class="sr-only">Live meeting: </span>{{ live.title }}
              </span>
            </span>
          } @else {
            <span class="live-meeting none" role="status">No meeting live</span>
          }
        }
        <button
          class="nav-toggle"
          type="button"
          (click)="toggle()"
          [attr.aria-expanded]="menuOpen()"
          aria-controls="nav-links"
          [attr.aria-label]="menuOpen() ? 'Close navigation' : 'Open navigation'"
        >
          {{ menuOpen() ? "✕" : "☰" }}
        </button>
      </div>

      <div id="nav-links" class="nav-links" [class.open]="menuOpen()">
        <!--
          Grouped by AUDIENCE, not by feature.

          Thirteen links in one flat row asked every visitor to scan the whole application to find
          their own two entries. Taking part in a meeting, running one, and administering the
          deployment are three different jobs usually done by three different people — so the
          participant links stay in the bar, and the other two collapse into menus that only appear
          for someone who holds the role.

          On narrow screens the menus flatten into labelled sections: a dropdown inside a dropdown
          is worse than a list, and the hamburger has already solved the space problem.
        -->

        <!-- Taking part — everyone. -->
        <a routerLink="/ask" routerLinkActive="active" (click)="close()">Ask a question</a>
        @if (auth.isAuthenticated()) {
          @if (features.enabled("LOUNGE_CHAT")) {
            <a routerLink="/chat" routerLinkActive="active" (click)="close()">💬 Lounge</a>
          }
          @if (features.enabled("VIDEO_LIBRARY")) {
            <a routerLink="/recordings" routerLinkActive="active" (click)="close()">🎬 Recordings</a>
          }
          <!--
            Voting is every member's, not just the chair's — the same page is the ballot and the
            controls. Whether this user may actually cast a vote depends on the meeting's member
            list, which only the server knows.
          -->
          @if (features.enabled("VOTING")) {
            <a routerLink="/voting" routerLinkActive="active" (click)="close()">🗳️ Voting</a>
          }
        }

        <!-- Running the meeting — moderators. -->
        @if (auth.isModerator()) {
          <div class="menu" [class.flat]="menuOpen()">
            <button
              type="button"
              class="menu-trigger"
              [attr.aria-expanded]="openMenu() === 'run'"
              aria-haspopup="true"
              (click)="toggleMenu('run')"
            >
              Run the meeting <span class="caret" aria-hidden="true"></span>
            </button>
            <div class="menu-items" [class.open]="openMenu() === 'run'">
              <a routerLink="/board" routerLinkActive="active" (click)="close()">Moderator board</a>
              <!--
                One condition, not two nested ones. This used to be wrapped in a check for
                RUN_OF_SHOW as well, left over from when a separate run-of-show page was planned;
                run-of-show now lives on the moderator board, so the outer test only had the effect
                of hiding Reports whenever RUN_OF_SHOW happened to be off.
              -->
              @if (features.enabled("MEETING_REPORTS")) {
                <a routerLink="/reports" routerLinkActive="active" (click)="close()">Reports</a>
              }
              @if (features.enabled("VIDEO_LIBRARY")) {
                <a routerLink="/videos" routerLinkActive="active" (click)="close()">Video library</a>
              }
              <a routerLink="/setup" routerLinkActive="active" (click)="close()">Knowledge base</a>
              <a routerLink="/members" routerLinkActive="active" (click)="close()">Members</a>
            </div>
          </div>
        }

        <!--
          Administering the deployment — admins and the two manager duties.

          Gated on the menu HAVING something in it, not merely on the role. A meeting manager whose
          deployment has MEETINGS switched off, and who is not an admin, previously saw an
          "Administration" button that opened an empty box: an affordance for nothing, which reads
          as broken rather than as unavailable.
        -->
        @if (showAdminMenu()) {
          <div class="menu" [class.flat]="menuOpen()">
            <button
              type="button"
              class="menu-trigger"
              [attr.aria-expanded]="openMenu() === 'admin'"
              aria-haspopup="true"
              (click)="toggleMenu('admin')"
            >
              Administration <span class="caret" aria-hidden="true"></span>
            </button>
            <div class="menu-items" [class.open]="openMenu() === 'admin'">
              @if (auth.managesMeetings() && features.enabled("MEETINGS")) {
                <a routerLink="/meetings" routerLinkActive="active" (click)="close()">Meetings</a>
              }
              @if (auth.hasRole("ADMIN")) {
                <a routerLink="/features" routerLinkActive="active" (click)="close()">Features</a>
              }
            </div>
          </div>
        }

        <span class="nav-spacer"></span>

        <!-- Always shown, signed in or not: the questions people most need answered are the ones
             they have when something is not working, and that includes signing in. -->
        <a routerLink="/help" routerLinkActive="active" (click)="close()">Help</a>

        @if (auth.isAuthenticated()) {
          <div class="menu account" [class.flat]="menuOpen()">
            <button
              type="button"
              class="menu-trigger"
              [attr.aria-expanded]="openMenu() === 'account'"
              aria-haspopup="true"
              (click)="toggleMenu('account')"
            >
              <span class="avatar" aria-hidden="true">{{ initial() }}</span>
              <span class="nav-user">{{ auth.username() }}</span>
              <span class="caret" aria-hidden="true"></span>
            </button>
            <div class="menu-items right" [class.open]="openMenu() === 'account'">
              <span class="menu-heading">{{ roleLabel() }}</span>
              <a routerLink="/security" routerLinkActive="active" (click)="close()">Security</a>
              <button type="button" class="menu-action" (click)="logout()">Sign out</button>
            </div>
          </div>
        } @else {
          <a routerLink="/login" routerLinkActive="active" (click)="close()">Login</a>
        }
      </div>
    </nav>
    <!-- tabindex="-1" so the skip link can move focus here, not just the scroll position. -->
    <main id="main" tabindex="-1">
      <router-outlet></router-outlet>
    </main>

    <!--
      THE VIDEO PLAYER LIVES HERE, OUTSIDE THE OUTLET, AND THAT IS THE WHOLE POINT.

      A picture-in-picture session ends the moment its <video> element leaves the document — the
      specification says so, and moving a node with appendChild removes it before re-inserting it.
      So the element can never be moved and never be unmounted by a navigation. Being a sibling of
      the outlet rather than a child of it is what guarantees both.

      The recordings page renders an empty slot and reports where it is; this layer is positioned
      over that slot in document coordinates. Navigating changes only CSS. Nothing moves.

      Parked (box() === null) means "playing in the floating window while the viewer is elsewhere":
      still connected, still playing, just nowhere on screen.
    -->
    <!--
      @defer, and it is not an optimisation — it is the difference between a 138 kB first load and a
      279 kB one.

      The player pulls in hls.js. Referenced normally from this component it lands in the MAIN
      bundle, so every visitor downloads a video library before seeing the question form, whether or
      not they ever open a recording. Used only inside a @defer block, the compiler keeps it in a
      chunk of its own and fetches it the first time a recording is actually selected — which is
      where it used to live, back when the lazy-loaded recordings page owned it.
    -->
    @defer (when playerHost.card()) {
      @if (playerHost.card(); as card) {
        <div
          class="player-layer"
          [class.parked]="!playerHost.box()"
          [style.top.px]="playerHost.box()?.top"
          [style.left.px]="playerHost.box()?.left"
          [style.width.px]="playerHost.box()?.width"
          [style.height.px]="playerHost.box()?.height"
        >
          <app-video-player
            #hostedPlayer
            [card]="card"
            [autoplay]="true"
            [startAt]="playerHost.startAt()"
          ></app-video-player>
        </div>
      }
    }

    <!--
      Outside the outlet on purpose: it is available on every page, and mounting it per route would
      reset its state on each navigation. Renders nothing when signed out — the endpoints it calls
      require a session.
    -->
    @if (features.enabled("HELP_WIDGET")) {
      <app-help-widget></app-help-widget>
    }
    <footer class="site-footer">Copyright © 2026 Aditya Yadav</footer>
  `,
  styles: [
    `
      /* Fixed to the viewport, so it is visible wherever the page is scrolled to. */
      .loading-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        z-index: 200;
        background: rgba(56, 189, 248, 0.18);
        overflow: hidden;
      }
      /* An indeterminate sweep, deliberately: the interceptor knows a request is outstanding, not
         how far through it is. A bar that filled to 90% and waited would be inventing a number. */
      .loading-bar span {
        display: block;
        height: 100%;
        width: 40%;
        background: var(--accent);
        animation: loading-sweep 1.1s ease-in-out infinite;
      }
      @keyframes loading-sweep {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(350%); }
      }
      /* Without motion the sweep would be a static stripe that reads as a decoration. A steady
         full-width bar still says "something is happening" without moving. */
      @media (prefers-reduced-motion: reduce) {
        .caret { transition: none; }
        .blocking-spinner {
          animation: none;
          border-right-color: var(--accent);
          opacity: 0.6;
        }
        .loading-bar span {
          animation: none;
          width: 100%;
          opacity: 0.6;
        }
      }

      .blocking-overlay {
        position: fixed;
        inset: 0;
        z-index: 190;
        display: grid;
        place-items: center;
        background: rgba(15, 23, 42, 0.55);
        /* backdrop-filter is progressive: without support the dim alone still reads as "wait". */
        backdrop-filter: blur(1.5px);
      }
      .blocking-card {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 22px;
        border-radius: 12px;
        background: var(--card);
        border: 1px solid #334155;
        box-shadow: 0 16px 44px #0009;
        font-weight: 600;
      }
      .blocking-spinner {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        border: 2px solid var(--accent);
        border-right-color: transparent;
        animation: blocking-spin 0.8s linear infinite;
      }
      @keyframes blocking-spin {
        to { transform: rotate(360deg); }
      }

      .nav {
        background: var(--card);
      }
      .nav-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 24px;
      }
      .brand {
        margin-right: auto;
      }

      .live-meeting {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 5px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        background: rgba(56, 189, 248, 0.14);
        color: var(--accent);
        border: 1px solid rgba(56, 189, 248, 0.35);
        /* A long meeting title must not push the hamburger off a narrow screen. */
        max-width: 42vw;
        min-width: 0;
      }
      .live-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .live-meeting.none {
        background: transparent;
        color: var(--muted);
        border-color: #33415588;
      }
      .live-dot {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: currentColor;
        animation: live-pulse 2s ease-in-out infinite;
      }
      @keyframes live-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      @media (prefers-reduced-motion: reduce) {
        .live-dot { animation: none; }
      }
      .brand {
        color: var(--accent);
        font-weight: 800;
        text-decoration: none;
        font-size: 16px;
        white-space: nowrap;
      }
      .nav-toggle {
        display: none;
        background: none;
        border: none;
        color: var(--text);
        font-size: 22px;
        line-height: 1;
        padding: 4px 8px;
        cursor: pointer;
        width: auto;
      }
      .nav-links {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 0 24px 12px;
      }
      .nav-links a {
        color: var(--muted);
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
      }
      .nav-links a.active {
        color: var(--accent);
      }

      /* ---- grouped menus ---- */
      .menu {
        position: relative;
      }
      .menu-trigger {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        background: none;
        border: none;
        color: var(--muted);
        font-weight: 600;
        font-size: inherit;
        padding: 4px 2px;
        width: auto;
        cursor: pointer;
      }
      .menu-trigger:hover,
      .menu-trigger[aria-expanded='true'] {
        color: var(--accent);
      }
      .caret {
        width: 6px;
        height: 6px;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(45deg) translate(-2px, -2px);
        transition: transform 0.15s ease;
      }
      .menu-trigger[aria-expanded='true'] .caret {
        transform: rotate(-135deg) translate(-2px, -2px);
      }

      .menu-items {
        display: none;
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        min-width: 200px;
        padding: 6px;
        border-radius: 10px;
        background: var(--card);
        border: 1px solid #334155;
        box-shadow: 0 12px 32px #0008;
        z-index: 80;
      }
      /* Anchored to the right edge for the account menu, which sits at the end of the bar and
         would otherwise open off the side of the screen. */
      .menu-items.right {
        left: auto;
        right: 0;
      }
      .menu-items.open {
        display: flex;
        flex-direction: column;
      }
      .menu-items a,
      .menu-action {
        display: block;
        padding: 9px 12px;
        border-radius: 7px;
        text-align: left;
        background: none;
        border: none;
        color: var(--muted);
        font: inherit;
        font-weight: 600;
        width: 100%;
        cursor: pointer;
        border-bottom: 0;
      }
      .menu-items a:hover,
      .menu-action:hover {
        background: rgba(56, 189, 248, 0.12);
        color: var(--accent);
      }
      .menu-heading {
        padding: 6px 12px 8px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        opacity: 0.75;
        border-bottom: 1px solid #33415555;
        margin-bottom: 4px;
      }

      .avatar {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--accent);
        color: #04222f;
        font-size: 12px;
        font-weight: 800;
      }
      .nav-spacer {
        flex: 1;
      }
      .nav-user {
        white-space: nowrap;
      }
      /*
        Absolute, in DOCUMENT coordinates — not fixed in viewport ones. Scrolling then moves the
        layer with the page for free, and only a resize or a layout change needs re-measuring.
      */
      .player-layer {
        position: absolute;
        z-index: 5;
      }
      /*
        Parked: off-screen but STILL RENDERED and still in the document. Not display:none, and
        never detached — either would end the picture-in-picture session this exists to preserve.
      */
      .player-layer.parked {
        position: fixed;
        top: auto;
        bottom: 0;
        left: 0;
        width: 1px;
        height: 1px;
        overflow: hidden;
        opacity: 0;
        pointer-events: none;
        z-index: -1;
      }
      .site-footer {
        color: var(--muted);
        font-size: 12px;
        text-align: center;
        padding: 24px 16px;
      }

      /* On phones/tablets the brand + hamburger share one bar and the links drop
       into a vertical menu toggled by the button. */
      @media (max-width: 760px) {
        .nav-bar {
          padding: 12px 16px;
        }
        /* The title is the useful part on a phone; the pill chrome is not worth the width. */
        .live-meeting {
          max-width: 38vw;
          padding: 4px 9px;
        }
        .nav-toggle {
          display: block;
        }
        .nav-links {
          display: none;
          flex-direction: column;
          align-items: flex-start;
          gap: 4px;
          padding: 0 16px 12px;
        }
        .nav-links.open {
          display: flex;
        }
        .nav-links a {
          padding: 10px 0;
          width: 100%;
          border-bottom: 1px solid #33415533;
        }
        .nav-spacer {
          display: none;
        }
        /* In the drawer the menus become labelled SECTIONS rather than dropdowns. A dropdown
           inside a dropdown is worse than a list, and the hamburger has already solved the space
           problem that made them worth having. */
        .menu.flat,
        .menu.flat .menu-items {
          display: block;
          position: static;
          width: 100%;
          min-width: 0;
          border: none;
          box-shadow: none;
          background: none;
          padding: 0;
        }
        .menu.flat .menu-trigger {
          width: 100%;
          justify-content: flex-start;
          padding: 12px 0 6px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          opacity: 0.7;
          pointer-events: none;   /* a section heading, not a control */
        }
        .menu.flat .caret {
          display: none;
        }
        .menu.flat .menu-items a,
        .menu.flat .menu-action {
          padding: 10px 0;
          border-bottom: 1px solid #33415533;
          border-radius: 0;
        }
        .menu.flat .menu-heading {
          display: none;
        }
        .nav-user {
          padding: 8px 0;
        }
      }
    `,
  ],
})
export class AppComponent {
  readonly menuOpen = signal(false);

  /**
   * Which dropdown is open, or null.
   *
   * <p>One signal rather than a boolean per menu: only one can be open at a time, and separate
   * flags make "close the others" a rule somebody has to remember on every new menu.
   */
  readonly openMenu = signal<'run' | 'admin' | 'account' | null>(null);

  /**
   * The signed-in state the session data was last loaded for, or null before the first run.
   *
   * <p>A plain field, not a signal, on purpose: writing a signal inside the effect that reads it
   * is how loops start, and nothing renders this.
   */
  /**
   * Whether the Administration menu would contain anything.
   *
   * <p>Mirrors the conditions on the entries inside it. A menu is a promise that something is
   * behind it; opening one to find nothing is worse than not being offered it, because the reader
   * cannot tell "not for you" from "broken".
   *
   * <p>Kept next to the template it serves rather than inlined into it: the two entry conditions
   * appear in both places, and having them side by side is what stops one being updated without
   * the other.
   */
  protected readonly showAdminMenu = computed(
    () =>
      this.auth.hasRole("ADMIN") ||
      (this.auth.managesMeetings() && this.features.enabled("MEETINGS")),
  );

  /**
   * The hosted player, handed to PlayerHostService so the recordings page can still reach it.
   *
   * <p>That page used `viewChild` when it owned the player. It does not own it any more, so the
   * instance travels through the service instead — see PlayerHostService.player.
   */
  private readonly hostedPlayer = viewChild<VideoPlayerComponent>('hostedPlayer');

  /**
   * Publish the hosted player so the recordings page can reach it.
   *
   * <p>That page uses it for the transcript, for seeking from a segment or a comment, and for the
   * playhead on the comment composer. It read those off a local `viewChild` while it owned the
   * player; now the instance is created here, so it has to travel through the service.
   *
   * <p>An effect rather than a lifecycle hook because the player comes and goes: it is inside a
   * @defer block and an @if, so it appears when the first recording is chosen and disappears when
   * playback is finished with. Publishing null in between is correct — the page checks.
   */
  /**
   * Expose a state snapshot for the browser console: `__pipState()`.
   *
   * <p>Not a debugging leftover — it is the thing that was missing. Whether the handover works
   * depends on facts only the browser holds (does it report a session? is the player mounted? is
   * the slot a real size?), and without a way to ask, every diagnosis was a guess. Reading state is
   * harmless, so it is always available rather than hidden behind the debug flag.
   */
  private readonly exposeSnapshot = effect(() => {
    (window as unknown as Record<string, unknown>)['__pipState'] = () =>
      this.playerHost.snapshot();
  });

  private readonly publishPlayer = effect(() => {
    const player = this.hostedPlayer() ?? null;
    untracked(() => this.playerHost.registerPlayer(player));
  });

  private sessionLoadedFor: boolean | null = null;

  /**
   * Records the URL we last reloaded for, so a stale-chunk recovery cannot loop.
   *
   * <p>sessionStorage rather than a field: the recovery is a full page load, which throws away
   * every field on this class. Something that survives the reload is the only thing that can tell
   * "we just tried this" from "first attempt".
   */
  private static readonly RELOAD_MARKER = 'agm_chunk_reload_for';

  /** First letter of the username, for the account button. */
  readonly initial = computed(() => (this.auth.username() ?? '?').charAt(0).toUpperCase());

  /** "Admin · Meeting manager" — what this person is, for the account menu. */
  readonly roleLabel = computed(() => {
    const roles = this.auth.roles();
    if (!roles.length) return 'Signed in';
    return roles
      .map((r) => r.charAt(0) + r.slice(1).toLowerCase().replace(/_/g, ' '))
      .join(' · ');
  });

  toggleMenu(which: 'run' | 'admin' | 'account'): void {
    this.openMenu.update((current) => (current === which ? null : which));
  }

  /**
   * Close an open menu when the click lands outside it.
   *
   * <p>Bound on document rather than on a backdrop element: a backdrop that covers the page to
   * catch clicks also swallows the first click on whatever is underneath, so dismissing a menu
   * costs an extra click every time.
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.openMenu() === null) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.menu')) this.openMenu.set(null);
  }

  /** Escape closes the menu, then the mobile drawer — the order people expect. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.openMenu() !== null) {
      this.openMenu.set(null);
      return;
    }
    this.menuOpen.set(false);
  }

  constructor(
    public loading: LoadingService,
    public auth: AuthService,
    public features: FeatureService,
    public meetings: MeetingService,
    public playerHost: PlayerHostService,
    private router: Router,
  ) {
    // Recover from a lazy chunk that no longer exists.
    //
    // Every page here is loaded on demand (`loadComponent`), and each build gives those files new
    // hashed names. A browser that still has the PREVIOUS index.html open — a tab left open across
    // a deploy, or a cached one — asks for filenames the server no longer has. The dynamic import
    // rejects, the router abandons the navigation, and the page simply stays where it is.
    //
    // From the user's side nothing happens at all: they click Voting, or Recordings, and the
    // application ignores them. No error, no spinner, nothing to report beyond "the menu is
    // broken" — which is why this is worth handling rather than leaving to a support conversation.
    //
    // Reloading fetches the current index.html and, with it, the filenames that actually exist.
    // location.assign rather than router.navigate on purpose: the router would reuse the same dead
    // module map and fail again in exactly the same way.
    this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationError)) return;

      const reason = String(event.error?.message ?? event.error ?? '');
      const isStaleChunk =
        event.error?.name === 'ChunkLoadError' ||
        /failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk .* failed|importing a module script failed/i.test(
          reason,
        );
      if (!isStaleChunk) return;

      // Reload ONCE per target. If the file is missing for any other reason — a genuinely broken
      // deploy — reloading again would spin forever, and an endless refresh is a worse failure
      // than the dead click it was meant to fix.
      const alreadyTried = sessionStorage.getItem(AppComponent.RELOAD_MARKER);
      if (alreadyTried === event.url) return;
      sessionStorage.setItem(AppComponent.RELOAD_MARKER, event.url);
      location.assign(event.url);
    });
    // Which features this user may see depends on who they are, so re-read whenever the session
    // changes — on sign-in and on sign-out.
    //
    // GUARDED ON THE TRANSITION, and the guard is load-bearing.
    //
    // isAuthenticated() is a computed over the token signal, so it re-evaluates on every token
    // WRITE — and the session renews itself periodically, with completeLogin() setting a brand-new
    // token string each time. Without the guard this effect re-ran on every renewal and fired two
    // more requests, which is how a single page load turned into my-features and active-meeting
    // being called over and over.
    //
    // untracked() around the work is the second half: it stops anything read inside those calls
    // from becoming a dependency and re-arming the effect for a reason nobody intended.
    effect(() => {
      const signedIn = this.auth.isAuthenticated();

      untracked(() => {
        if (signedIn === this.sessionLoadedFor) return;   // nothing changed; do no work
        this.sessionLoadedFor = signedIn;

        if (!signedIn) {
          this.features.clear();
          return;
        }
        this.features.refresh().subscribe({ error: () => {} });
        // Read once per session rather than polled: activating a meeting is a deliberate act by a
        // manager, not something that changes under a reader every few seconds. Screens that act
        // on it — the ballot, the board — refresh it themselves when they load.
        this.meetings.refreshActive().subscribe({ error: () => {} });
      });
    });
  }

  toggle(): void {
    this.menuOpen.update((v) => !v);
  }
  close(): void {
    this.menuOpen.set(false);
    this.openMenu.set(null);
  }

  logout(): void {
    this.close();
    this.auth.logout();
    this.router.navigate(["/login"]);
  }
}
