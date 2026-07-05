import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';
import { ChatService, AI_PEER, Contact } from '../services/chat.service';
import { parseCitation } from '../services/api.service';

/**
 * Shareholder Lounge — WhatsApp-style 1-on-1 chat plus a pinned GenAI assistant.
 * Left: conversation list (AI Assistant on top, online dots, unread badges).
 * Right: message thread (sent/received bubbles, timestamps, ✓/✓✓ read ticks) + composer.
 */
@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="lounge">
      <!-- conversation list -->
      <aside class="peers">
        <div class="peers-head">
          <strong>Lounge</strong>
          <span class="dot" [class.on]="chat.connected()" [title]="chat.connected() ? 'connected' : 'offline'"></span>
        </div>

        <button class="peer ai" [class.sel]="chat.activePeer() === AI_PEER" (click)="select(AI_PEER)">
          <span class="avatar ai">✨</span>
          <span class="peer-main">
            <span class="peer-name">AI Assistant</span>
            <span class="peer-last">Ask about the annual report…</span>
          </span>
        </button>

        @for (c of others(); track c.username) {
          <button class="peer" [class.sel]="chat.activePeer() === c.username" (click)="select(c.username)">
            <span class="avatar">{{ initials(c.username) }}
              <span class="pres" [class.on]="c.online"></span>
            </span>
            <span class="peer-main">
              <span class="peer-name">{{ c.username }} <span class="role">{{ c.role }}</span></span>
              <span class="peer-last">{{ c.lastMessage || 'No messages yet' }}</span>
            </span>
            @if (c.unread > 0) { <span class="badge hot">{{ c.unread }}</span> }
          </button>
        }
        @if (others().length === 0) {
          <p class="muted" style="padding:12px">No other members yet. Registered users appear here.</p>
        }
      </aside>

      <!-- active thread -->
      <section class="thread">
        @if (chat.activePeer(); as peer) {
          <header class="thread-head">
            <span class="avatar" [class.ai]="peer === AI_PEER">{{ peer === AI_PEER ? '✨' : initials(peer) }}</span>
            <div>
              <div class="peer-name">{{ peer }}</div>
              @if (chat.typingPeer() === peer) {
                <div class="typing">typing…</div>
              } @else {
                <div class="muted">{{ peer === AI_PEER ? 'RAG-grounded on the annual report'
                                                       : (chat.online().has(peer) ? 'online' : 'offline') }}</div>
              }
            </div>
          </header>

          <div class="msgs">
            @for (m of chat.messages(); track m.id) {
              <div class="bubble" [class.mine]="isMine(m.sender)" [class.ai]="m.kind === 'AI'">
                <span class="body">{{ m.body }}</span>
                <span class="meta">
                  {{ time(m.sentAt) }}
                  @if (isMine(m.sender) && peer !== AI_PEER) {
                    <span class="ticks" [class.read]="!!m.readAt">{{ m.readAt ? '✓✓' : '✓' }}</span>
                  }
                </span>
              </div>
            }
            @if (chat.messages().length === 0) {
              <p class="muted" style="text-align:center;margin-top:40px">
                {{ peer === AI_PEER ? 'Ask the assistant anything about the company.' : 'Say hello 👋' }}
              </p>
            }
          </div>

          @if (peer === AI_PEER && chat.lastCitations().length) {
            <div class="cites">
              <span class="muted">Sources:</span>
              @for (c of chat.lastCitations(); track c.source) {
                <a class="cite-link" [href]="link(c.source)" target="_blank" rel="noopener">{{ c.source }}</a>
              }
            </div>
          }

          <footer class="composer">
            <input [ngModel]="draft()" (ngModelChange)="onType($event)"
                   (keyup.enter)="send()"
                   [placeholder]="peer === AI_PEER ? 'Ask the AI assistant…' : 'Type a message…'" />
            <button (click)="send()" [disabled]="!draft().trim() || busy()">
              {{ busy() ? '…' : 'Send' }}
            </button>
          </footer>
        } @else {
          <div class="empty">
            <p class="muted">Select a conversation to start chatting, or ask the ✨ AI Assistant.</p>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .lounge { display:flex; gap:16px; max-width:1000px; margin:16px auto; padding:0 16px;
              height:calc(100vh - 110px); }
    .peers { width:300px; background:var(--card); border-radius:12px; overflow-y:auto; flex-shrink:0; }
    .peers-head { display:flex; align-items:center; gap:8px; padding:14px 16px; border-bottom:1px solid #334155; }
    .peer { display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:none;
            border:none; border-bottom:1px solid #1e293b; padding:12px 14px; cursor:pointer; color:var(--text); }
    .peer:hover { background:#243449; }
    .peer.sel { background:#243449; }
    .peer.ai { border-bottom:1px solid #334155; }
    .peer-main { display:flex; flex-direction:column; flex:1; min-width:0; }
    .peer-name { font-weight:600; font-size:14px; }
    .peer-last { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .role { font-size:10px; color:var(--muted); font-weight:400; }
    .avatar { position:relative; width:38px; height:38px; border-radius:50%; background:#334155; color:var(--accent);
              display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; flex-shrink:0; }
    .avatar.ai { background:#3b2f5c; color:#c4b5fd; }
    .pres { position:absolute; right:-1px; bottom:-1px; width:11px; height:11px; border-radius:50%;
            background:#64748b; border:2px solid var(--card); }
    .pres.on { background:#22c55e; }
    .dot { width:10px; height:10px; border-radius:50%; background:#64748b; }
    .dot.on { background:#22c55e; }
    .thread { flex:1; background:var(--card); border-radius:12px; display:flex; flex-direction:column; min-width:0; }
    .thread-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid #334155; }
    .msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }
    .bubble { max-width:72%; padding:8px 12px; border-radius:12px; background:#243449; align-self:flex-start;
              display:flex; flex-direction:column; }
    .bubble.mine { align-self:flex-end; background:#0e7490; color:#e0f2fe; }
    .bubble.ai { background:#3b2f5c; color:#ede9fe; }
    .body { white-space:pre-wrap; font-size:14px; }
    .meta { font-size:10px; color:var(--muted); align-self:flex-end; margin-top:3px; }
    .bubble.mine .meta { color:#bae6fd; }
    .ticks.read { color:#38bdf8; }
    .cites { display:flex; flex-wrap:wrap; gap:8px; padding:8px 16px; border-top:1px solid #334155; align-items:center; }
    .cite-link { font-size:11px; color:var(--accent); }
    .typing { font-size:12px; color:#22c55e; font-style:italic; }
    .composer { display:flex; gap:8px; padding:12px 16px; border-top:1px solid #334155; }
    .composer input { flex:1; }
    .empty { flex:1; display:flex; align-items:center; justify-content:center; }
  `],
})
export class ChatComponent implements OnInit, OnDestroy {
  readonly AI_PEER = AI_PEER;
  readonly draft = signal('');
  readonly busy = signal(false);

  /** Real members (the AI Assistant is rendered separately, pinned on top). */
  readonly others = computed<Contact[]>(() => this.chat.contacts().filter((c) => c.username !== AI_PEER));

  constructor(protected chat: ChatService, private auth: AuthService) {}

  ngOnInit(): void {
    this.chat.connect();
    this.chat.loadContacts();
  }

  ngOnDestroy(): void {
    this.chat.disconnect();
  }

  select(peer: string): void {
    this.chat.lastCitations.set([]);
    this.chat.openThread(peer);
  }

  onType(value: string): void {
    this.draft.set(value);
    this.chat.sendTyping();
  }

  async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.busy()) return;
    this.busy.set(true);
    this.draft.set('');
    try {
      if (this.chat.activePeer() === AI_PEER) {
        await this.chat.askAi(text);
      } else {
        await this.chat.send(text);
      }
    } finally {
      this.busy.set(false);
    }
  }

  isMine(sender: string): boolean { return sender === this.auth.username(); }
  initials(name: string): string { return name.slice(0, 2).toUpperCase(); }
  link(source: string): string { return parseCitation(source).url; }
  time(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
