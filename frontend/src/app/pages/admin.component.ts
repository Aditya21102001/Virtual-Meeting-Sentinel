import { Component, OnInit, signal } from '@angular/core';
import { ApiService, KnowledgeStatus } from '../services/api.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  template: `
    <div class="container">
      <h1>Setup</h1>
      <p class="muted">
        Configure the meeting: upload the company's annual report (used to draft grounded
        answers) and, optionally, a bank of expected questions to pre-populate the board.
      </p>

      <!-- Annual report upload -->
      <div class="card">
        <div class="q">1 · Annual report (PDF)</div>
        <p class="muted">
          Indexed into the RAG knowledge base. Draft answers cite passages from this document.
        </p>
        <div class="row" style="margin-top:10px">
          <input type="file" accept="application/pdf" (change)="pickReport($event)" />
          <button (click)="uploadReport()" [disabled]="!reportFile() || reportBusy()">
            {{ reportBusy() ? 'Indexing…' : 'Upload & index' }}
          </button>
        </div>
        @if (reportMsg()) { <p class="muted" style="margin-top:8px">{{ reportMsg() }}</p> }

        @if (status(); as s) {
          <div class="draft" style="margin-top:10px">
            <strong>Knowledge base:</strong>
            {{ s.ready ? s.chunks_indexed + ' chunks indexed' : 'no report yet' }}
            @if (s.sources.length) { <br />Sources: {{ s.sources.join(', ') }} }
          </div>
        }
      </div>

      <!-- Question bank upload -->
      <div class="card">
        <div class="q">2 · Question bank (.txt / .csv — one question per line)</div>
        <p class="muted">
          Each line is clustered like a live question, so duplicates collapse automatically.
        </p>
        <div class="row" style="margin-top:10px">
          <input type="file" accept=".txt,.csv" (change)="pickBank($event)" />
          <button (click)="uploadBank()" [disabled]="!bankFile() || bankBusy()">
            {{ bankBusy() ? 'Ingesting…' : 'Upload & ingest' }}
          </button>
        </div>
        @if (bankMsg()) { <p class="muted" style="margin-top:8px">{{ bankMsg() }}</p> }
      </div>

      <p class="muted">Then open the <strong>Moderator board</strong> to see the results.</p>
    </div>
  `,
})
export class AdminComponent implements OnInit {
  readonly reportFile = signal<File | null>(null);
  readonly bankFile = signal<File | null>(null);
  readonly reportBusy = signal(false);
  readonly bankBusy = signal(false);
  readonly reportMsg = signal('');
  readonly bankMsg = signal('');
  readonly status = signal<KnowledgeStatus | null>(null);

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.refreshStatus();
  }

  private refreshStatus(): void {
    this.api.knowledgeStatus().subscribe({ next: (s) => this.status.set(s) });
  }

  pickReport(e: Event): void {
    this.reportFile.set((e.target as HTMLInputElement).files?.[0] ?? null);
    this.reportMsg.set('');
  }

  pickBank(e: Event): void {
    this.bankFile.set((e.target as HTMLInputElement).files?.[0] ?? null);
    this.bankMsg.set('');
  }

  uploadReport(): void {
    const file = this.reportFile();
    if (!file) return;
    this.reportBusy.set(true);
    this.api.uploadAnnualReport(file).subscribe({
      next: (res) => {
        this.reportMsg.set(`✓ Indexed "${res.filename}" — ${res.chunks_indexed} chunks.`);
        this.reportBusy.set(false);
        this.refreshStatus();
      },
      error: (err) => {
        this.reportMsg.set('✗ ' + (err?.error?.error ?? 'Upload failed. Is the server running?'));
        this.reportBusy.set(false);
      },
    });
  }

  uploadBank(): void {
    const file = this.bankFile();
    if (!file) return;
    this.bankBusy.set(true);
    this.api.uploadQuestionBank(file).subscribe({
      next: (res) => {
        this.bankMsg.set(`✓ Ingested ${res.ingested} of ${res.received} questions.`);
        this.bankBusy.set(false);
      },
      error: () => {
        this.bankMsg.set('✗ Upload failed. Is the server running?');
        this.bankBusy.set(false);
      },
    });
  }
}
