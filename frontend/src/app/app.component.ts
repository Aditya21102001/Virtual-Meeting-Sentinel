import { Component, effect, signal } from "@angular/core";
import {
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
  Router,
} from "@angular/router";
import { HelpWidgetComponent } from "./components/help-widget.component";
import { AuthService } from "./services/auth.service";
import { FeatureService } from "./services/feature.service";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, HelpWidgetComponent],
  template: `
    <nav class="nav">
      <div class="nav-bar">
        <a class="brand" routerLink="/ask" (click)="close()"
          >🛡️ VIRTUAL MEETING Sentinel</a
        >
        <button
          class="nav-toggle"
          type="button"
          (click)="toggle()"
          [attr.aria-expanded]="menuOpen()"
          aria-label="Toggle navigation"
        >
          {{ menuOpen() ? "✕" : "☰" }}
        </button>
      </div>

      <div class="nav-links" [class.open]="menuOpen()">
        <a routerLink="/ask" routerLinkActive="active" (click)="close()"
          >Ask a question</a
        >
        @if (auth.isAuthenticated()) {
          @if (features.enabled("LOUNGE_CHAT")) {
            <a routerLink="/chat" routerLinkActive="active" (click)="close()"
              >💬 Lounge</a
            >
          }
          @if (features.enabled("VIDEO_LIBRARY")) {
            <a
              routerLink="/recordings"
              routerLinkActive="active"
              (click)="close()"
              >🎬 Recordings</a
            >
          }
          <!--
            Voting is every signed-in member's, not just the chair's — the same page is the ballot
            and the controls. Whether this particular user may actually cast a vote depends on the
            meeting's member list, which only the server knows, so the link is shown to everyone and
            the page explains it if they are not entitled.
          -->
          @if (features.enabled("VOTING")) {
            <a routerLink="/voting" routerLinkActive="active" (click)="close()"
              >🗳️ Voting</a
            >
          }
        }
        @if (auth.isModerator()) {
          <a routerLink="/board" routerLinkActive="active" (click)="close()"
            >Moderator board</a
          >
          <a routerLink="/setup" routerLinkActive="active" (click)="close()"
            >Setup</a
          >
          @if (features.enabled("VIDEO_LIBRARY")) {
            <a routerLink="/videos" routerLinkActive="active" (click)="close()"
              >Video library</a
            >
          }
          <a routerLink="/members" routerLinkActive="active" (click)="close()"
            >Members</a
          >
          @if (features.enabled("MEETING_REPORTS")) {
            <a routerLink="/reports" routerLinkActive="active" (click)="close()"
              >Reports</a
            >
          }
        }
        <!--
          Its own duty, not part of being a moderator: a MEETING_MANAGER schedules meetings, a
          USER_MANAGER maps people into them, and either may be someone who never touches the board.
        -->
        @if (auth.hasRole("ADMIN")) {
          <a routerLink="/features" routerLinkActive="active" (click)="close()"
            >Features</a
          >
        }
        @if (auth.managesMeetings() && features.enabled("MEETINGS")) {
          <a routerLink="/meetings" routerLinkActive="active" (click)="close()"
            >Meetings</a
          >
        }
        <span class="nav-spacer"></span>
        <!-- Always shown, signed in or not: the questions people most need answered are the ones
             they have when something is not working, and that includes signing in. -->
        <a routerLink="/help" routerLinkActive="active" (click)="close()">Help</a>
        @if (auth.isAuthenticated()) {
          <a routerLink="/security" routerLinkActive="active" (click)="close()"
            >Security</a
          >
          <span class="muted nav-user">{{ auth.username() }}</span>
          <a class="nav-action" (click)="logout()">Logout</a>
        } @else {
          <a routerLink="/login" routerLinkActive="active" (click)="close()"
            >Login</a
          >
        }
      </div>
    </nav>
    <router-outlet></router-outlet>

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
      .nav {
        background: var(--card);
      }
      .nav-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 24px;
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
      .nav-spacer {
        flex: 1;
      }
      .nav-user {
        white-space: nowrap;
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
        .nav-user {
          padding: 8px 0;
        }
      }
    `,
  ],
})
export class AppComponent {
  readonly menuOpen = signal(false);

  constructor(
    public auth: AuthService,
    public features: FeatureService,
    private router: Router,
  ) {
    // Which features this user may see depends on who they are, so re-read whenever the session
    // changes — on sign-in, on sign-out, and when a renewed token brings different roles.
    effect(() => {
      if (this.auth.isAuthenticated()) {
        this.features.refresh().subscribe({ error: () => {} });
      } else {
        this.features.clear();
      }
    });
  }

  toggle(): void {
    this.menuOpen.update((v) => !v);
  }
  close(): void {
    this.menuOpen.set(false);
  }

  logout(): void {
    this.close();
    this.auth.logout();
    this.router.navigate(["/login"]);
  }
}
