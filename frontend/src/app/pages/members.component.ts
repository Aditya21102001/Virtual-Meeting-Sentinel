import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Member } from '../services/api.service';

/**
 * Members & roles (moderator/admin). Lists registered users and lets you assign
 * ADMIN / MODERATOR / SHAREHOLDER — this is what activates the otherwise-unassigned roles.
 */
@Component({
  selector: 'app-members',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container">
      <h1>Members & roles</h1>
      <p class="muted">
        Registered users. Assign <strong>SHAREHOLDER</strong> to let someone into the Lounge, or
        <strong>MODERATOR/ADMIN</strong> for board access. New sign-ups default to MODERATOR.
      </p>

      @if (msg(); as m) { <div class="card"><span class="badge">{{ m }}</span></div> }

      <div class="card">
        @for (u of members(); track u.id) {
          <div class="row" style="justify-content:space-between; padding:8px 0; border-bottom:1px solid #1e293b">
            <div>
              <div class="q" style="margin:0">{{ u.username }}</div>
              <div class="muted">{{ u.email || 'no email' }}</div>
            </div>
            <div class="row">
              <span class="badge" [class.hot]="u.role === 'ADMIN'">{{ u.role }}</span>
              <select [ngModel]="u.role" (ngModelChange)="changeRole(u, $event)"
                      style="width:auto; padding:8px 10px">
                <option value="SHAREHOLDER">SHAREHOLDER</option>
                <option value="MODERATOR">MODERATOR</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </div>
          </div>
        }
        @if (members().length === 0) { <p class="muted">No registered users yet.</p> }
      </div>
    </div>
  `,
})
export class MembersComponent implements OnInit {
  readonly members = signal<Member[]>([]);
  readonly msg = signal<string | null>(null);

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.listUsers().subscribe({
      next: (m) => this.members.set(m),
      error: () => this.msg.set('Could not load members (need moderator/admin access).'),
    });
  }

  changeRole(user: Member, role: string): void {
    if (role === user.role) return;
    this.api.setUserRole(user.id, role).subscribe({
      next: (updated) => {
        this.members.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
        this.msg.set(`${updated.username} is now ${updated.role}.`);
      },
      error: () => this.msg.set('Role update failed.'),
    });
  }
}
