import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { Client, IMessage } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { Citation } from './api.service';

export interface ChatMessage {
  id: string;
  sender: string;
  recipient: string;
  body: string;
  sentAt: string;
  readAt: string | null;
  kind: 'USER' | 'AI';
}

export interface Contact {
  username: string;
  role: string;
  online: boolean;
  lastMessage: string | null;
  lastAt: string | null;
  unread: number;
}

export interface AiChatResult {
  answer: string;
  citations: Citation[];
}

/** The virtual peer the GenAI assistant conversation is stored against (matches the backend). */
export const AI_PEER = 'AI Assistant';

/**
 * Shareholder Lounge transport + state. Authenticated STOMP over SockJS (JWT in the CONNECT
 * frame, read by the backend's WebSocketAuthInterceptor) for live 1-on-1 delivery, presence and
 * read receipts; plain HTTP for history/send/GenAI. Uses signals so the zoneless app re-renders.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly base = environment.apiBase;
  private client?: Client;

  readonly connected = signal(false);
  readonly contacts = signal<Contact[]>([]);
  readonly messages = signal<ChatMessage[]>([]);   // the active thread
  readonly online = signal<Set<string>>(new Set());
  readonly activePeer = signal<string | null>(null);
  readonly typingPeer = signal<string | null>(null);   // peer currently typing to me
  private typingTimer?: ReturnType<typeof setTimeout>;
  private lastTypingSent = 0;

  constructor(private http: HttpClient, private auth: AuthService) {}

  // ---- WebSocket ---------------------------------------------------------
  connect(): void {
    if (this.client?.active) return;
    const token = this.auth.token() ?? '';

    this.client = new Client({
      webSocketFactory: () => new SockJS(environment.wsUrl) as any,
      // The JWT rides in the STOMP CONNECT frame so the backend can set our Principal.
      connectHeaders: { Authorization: `Bearer ${token}` },
      reconnectDelay: 4000,
      onConnect: () => {
        this.connected.set(true);
        this.client!.subscribe('/user/queue/messages', (m: IMessage) => this.onMessage(JSON.parse(m.body)));
        this.client!.subscribe('/user/queue/read', (m: IMessage) => this.onRead(JSON.parse(m.body)));
        this.client!.subscribe('/user/queue/typing', (m: IMessage) => this.onTyping(JSON.parse(m.body)));
        this.client!.subscribe('/topic/presence', (m: IMessage) => this.onPresence(JSON.parse(m.body)));
      },
      onDisconnect: () => this.connected.set(false),
      onWebSocketClose: () => this.connected.set(false),
    });
    this.client.activate();
  }

  disconnect(): void {
    this.client?.deactivate();
    this.connected.set(false);
  }

  private onMessage(msg: ChatMessage): void {
    // A delivered message ends any "typing" state from that peer.
    if (this.typingPeer() === msg.sender) this.typingPeer.set(null);
    // Append to the open thread if it belongs to the active peer, then refresh badges.
    if (this.activePeer() && msg.sender === this.activePeer()) {
      this.messages.update((list) => [...list, msg]);
      this.markRead(msg.sender);   // I'm looking at it → mark read + send receipt
    }
    this.loadContacts();
  }

  private onTyping(evt: { from: string }): void {
    if (this.activePeer() !== evt.from) return;   // only show for the open conversation
    this.typingPeer.set(evt.from);
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.typingPeer.set(null), 3000);
  }

  /** Tell the active peer we're typing (throttled to ~1/sec; skipped for the AI assistant). */
  sendTyping(): void {
    const peer = this.activePeer();
    if (!peer || peer === AI_PEER || !this.client?.connected) return;
    const now = Date.now();
    if (now - this.lastTypingSent < 1000) return;
    this.lastTypingSent = now;
    this.client.publish({ destination: '/app/typing', body: JSON.stringify({ to: peer }) });
  }

  private onRead(evt: { reader: string }): void {
    // The peer opened our conversation → flip our sent messages to that peer to read (✓✓).
    if (this.activePeer() === evt.reader) {
      const now = new Date().toISOString();
      this.messages.update((list) =>
        list.map((m) => (m.recipient === evt.reader && !m.readAt ? { ...m, readAt: now } : m)));
    }
  }

  private onPresence(evt: { user: string; online: boolean }): void {
    this.online.update((set) => {
      const next = new Set(set);
      evt.online ? next.add(evt.user) : next.delete(evt.user);
      return next;
    });
    // Reflect the dot in the contact list too.
    this.contacts.update((cs) => cs.map((c) => (c.username === evt.user ? { ...c, online: evt.online } : c)));
  }

  // ---- HTTP --------------------------------------------------------------
  private get headers(): Record<string, string> {
    const t = this.auth.token();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  async loadContacts(): Promise<void> {
    const cs = await firstValueFrom(
      this.http.get<Contact[]>(`${this.base}/api/chat/contacts`, { headers: this.headers }));
    this.contacts.set(cs);
    this.online.set(new Set(cs.filter((c) => c.online).map((c) => c.username)));
  }

  async openThread(peer: string): Promise<void> {
    this.activePeer.set(peer);
    this.typingPeer.set(null);
    const msgs = await firstValueFrom(
      this.http.get<ChatMessage[]>(`${this.base}/api/chat/messages/${encodeURIComponent(peer)}`, { headers: this.headers }));
    this.messages.set(msgs);
    this.loadContacts();   // unread badge for this peer clears
  }

  async send(body: string): Promise<void> {
    const peer = this.activePeer();
    if (!peer) return;
    const saved = await firstValueFrom(
      this.http.post<ChatMessage>(`${this.base}/api/chat/messages`, { to: peer, body }, { headers: this.headers }));
    this.messages.update((list) => [...list, saved]);
  }

  /** GenAI assistant turn: optimistically render my message, then the grounded reply. */
  async askAi(body: string): Promise<void> {
    const mine: ChatMessage = {
      id: 'local-' + body.length + '-' + body.slice(0, 8),
      sender: this.auth.username() ?? 'me', recipient: AI_PEER, body,
      sentAt: new Date().toISOString(), readAt: null, kind: 'USER',
    };
    this.messages.update((list) => [...list, mine]);
    const res = await firstValueFrom(
      this.http.post<AiChatResult>(`${this.base}/api/chat/ai`, { body }, { headers: this.headers }));
    const reply: ChatMessage = {
      id: 'ai-' + res.answer.length, sender: AI_PEER, recipient: this.auth.username() ?? 'me',
      body: res.answer, sentAt: new Date().toISOString(), readAt: null, kind: 'AI',
    };
    this.messages.update((list) => [...list, reply]);
    this.lastCitations.set(res.citations ?? []);
  }

  /** Citations from the most recent AI reply, for the component to render as links. */
  readonly lastCitations = signal<Citation[]>([]);

  private async markRead(peer: string): Promise<void> {
    // Re-fetching the thread marks peer→me messages read server-side and emits the receipt.
    await firstValueFrom(
      this.http.get<ChatMessage[]>(`${this.base}/api/chat/messages/${encodeURIComponent(peer)}`, { headers: this.headers }));
  }
}
