import { Component, signal } from "@angular/core";
import {
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
  Router,
} from "@angular/router";
import { AuthService } from "./services/auth.service";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
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
          <a routerLink="/chat" routerLinkActive="active" (click)="close()"
            >💬 Lounge</a
          >
        }
        @if (auth.isModerator()) {
          <a routerLink="/board" routerLinkActive="active" (click)="close()"
            >Moderator board</a
          >
          <a routerLink="/setup" routerLinkActive="active" (click)="close()"
            >Setup</a
          >
          <a routerLink="/members" routerLinkActive="active" (click)="close()"
            >Members</a
          >
        }
        <span class="nav-spacer"></span>
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
    private router: Router,
  ) {}

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
