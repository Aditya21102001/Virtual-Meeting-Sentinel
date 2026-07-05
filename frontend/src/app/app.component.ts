import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { AuthService } from './services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <nav class="nav">
      <strong style="color:var(--accent)">🛡️ AGM Sentinel</strong>
      <a routerLink="/ask" routerLinkActive="active">Ask a question</a>
      @if (auth.isAuthenticated()) {
        <a routerLink="/chat" routerLinkActive="active">💬 Lounge</a>
      }
      @if (auth.isModerator()) {
        <a routerLink="/board" routerLinkActive="active">Moderator board</a>
        <a routerLink="/setup" routerLinkActive="active">Setup</a>
        <a routerLink="/members" routerLinkActive="active">Members</a>
      }
      <span style="flex:1"></span>
      @if (auth.isAuthenticated()) {
        <a routerLink="/security" routerLinkActive="active">Security</a>
        <span class="muted">{{ auth.username() }}</span>
        <a style="cursor:pointer" (click)="logout()">Logout</a>
      } @else {
        <a routerLink="/login" routerLinkActive="active">Login</a>
      }
    </nav>
    <router-outlet></router-outlet>
  `,
})
export class AppComponent {
  constructor(public auth: AuthService, private router: Router) {}

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
