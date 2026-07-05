import { Routes } from '@angular/router';
import { AttendeeComponent } from './pages/attendee.component';
import { ModeratorComponent } from './pages/moderator.component';
import { AdminComponent } from './pages/admin.component';
import { LoginComponent } from './pages/login.component';
import { SecurityComponent } from './pages/security.component';
import { ChatComponent } from './pages/chat.component';
import { MembersComponent } from './pages/members.component';
import { authGuard, moderatorGuard } from './services/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'ask', pathMatch: 'full' },
  { path: 'ask', component: AttendeeComponent },
  { path: 'login', component: LoginComponent },
  // Shareholder Lounge: any signed-in member (chat + GenAI assistant).
  { path: 'chat', component: ChatComponent, canActivate: [authGuard] },
  // Moderator-only areas require a signed-in moderator (password + any enrolled MFA).
  { path: 'board', component: ModeratorComponent, canActivate: [moderatorGuard] },
  { path: 'setup', component: AdminComponent, canActivate: [moderatorGuard] },
  { path: 'members', component: MembersComponent, canActivate: [moderatorGuard] },
  { path: 'security', component: SecurityComponent, canActivate: [moderatorGuard] },
];
