import { Routes } from '@angular/router';
import { AttendeeComponent } from './pages/attendee.component';
import { ModeratorComponent } from './pages/moderator.component';
import { AdminComponent } from './pages/admin.component';
import { LoginComponent } from './pages/login.component';
import { SecurityComponent } from './pages/security.component';
import { ChatComponent } from './pages/chat.component';
import { MembersComponent } from './pages/members.component';
import {
  adminGuard,
  authGuard,
  meetingManagerGuard,
  moderatorGuard,
} from './services/auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'ask', pathMatch: 'full' },
  { path: 'ask', component: AttendeeComponent },
  { path: 'login', component: LoginComponent },
  // Help. Deliberately unguarded: "why can't I sign in" is a help question, and putting the answer
  // behind a sign-in would be a locked door with the key inside. Content is filtered by role and by
  // which features are on, so a signed-out reader simply sees the general topics. Lazy, because
  // most sessions never open it.
  {
    path: 'help',
    loadComponent: () => import('./pages/help.component').then((m) => m.HelpComponent),
  },
  // Shareholder Lounge: any signed-in member (chat + GenAI assistant).
  { path: 'chat', component: ChatComponent, canActivate: [authGuard] },
  // Meeting recordings: any signed-in member can watch on demand. Lazy-loaded so hls.js
  // (~250 kB) is fetched only by people who actually open a recording.
  {
    path: 'recordings',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/videos.component').then((m) => m.VideosComponent),
  },
  // Moderator-only areas require a signed-in moderator (password + any enrolled MFA).
  { path: 'board', component: ModeratorComponent, canActivate: [moderatorGuard] },
  { path: 'setup', component: AdminComponent, canActivate: [moderatorGuard] },
  {
    path: 'videos',
    canActivate: [moderatorGuard],
    loadComponent: () => import('./pages/video-admin.component').then((m) => m.VideoAdminComponent),
  },
  { path: 'members', component: MembersComponent, canActivate: [moderatorGuard] },
  // Meetings: a MEETING_MANAGER schedules and activates, a USER_MANAGER maps people in. Lazy —
  // most signed-in users hold neither duty and should not pay for the screen.
  // Feature switches. ADMIN only, and lazy — nobody else ever opens it.
  {
    path: 'features',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/features.component').then((m) => m.FeaturesComponent),
  },
  {
    path: 'meetings',
    canActivate: [meetingManagerGuard],
    loadComponent: () => import('./pages/meetings.component').then((m) => m.MeetingsComponent),
  },
  // Voting. Open to any signed-in user, because this is the members' ballot as well as the chair's
  // controls — the page shows one or both depending on role. Being allowed to open the page is not
  // the same as being entitled to vote: that comes from the meeting's member list and is decided by
  // the server. Lazy, since a deployment that takes no formal business never opens it.
  {
    path: 'voting',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/voting.component').then((m) => m.VotingComponent),
  },
  // Meeting reports. Moderator-only: a report gathers the whole meeting into one document,
  // including the questions nobody answered, which is a working record before it is a published one.
  {
    path: 'reports',
    canActivate: [moderatorGuard],
    loadComponent: () => import('./pages/reports.component').then((m) => m.ReportsComponent),
  },
  // Security is every signed-in member's own page — passwords, two-factor, their sessions. It was
  // behind moderatorGuard while the account menu offered it to everyone, so a shareholder clicking
  // their own security settings was bounced to the login screen.
  { path: 'security', component: SecurityComponent, canActivate: [authGuard] },
];
