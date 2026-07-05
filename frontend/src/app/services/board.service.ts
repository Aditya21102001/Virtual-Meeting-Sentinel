import { Injectable, signal } from '@angular/core';
import { Client, IMessage } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import { environment } from '../../environments/environment';
import { ClusterView } from './api.service';

/**
 * Subscribes to the backend's STOMP topic `/topic/board` and exposes the live,
 * ranked, deduplicated cluster board as signals the moderator view renders.
 *
 * Signals (not BehaviorSubject) so change detection works in a zoneless app: setting
 * a signal notifies Angular directly, with no zone.js to observe mutations.
 */
@Injectable({ providedIn: 'root' })
export class BoardService {
  private client?: Client;
  readonly board = signal<ClusterView[]>([]);
  readonly connected = signal<boolean>(false);

  connect(): void {
    if (this.client?.active) return;

    this.client = new Client({
      // SockJS handles the fallback + works behind free-tier proxies.
      webSocketFactory: () => new SockJS(environment.wsUrl) as any,
      reconnectDelay: 4000,
      onConnect: () => {
        this.connected.set(true);
        this.client!.subscribe('/topic/board', (msg: IMessage) => {
          const payload = JSON.parse(msg.body);
          this.board.set(payload.clusters ?? []);
        });
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
}
