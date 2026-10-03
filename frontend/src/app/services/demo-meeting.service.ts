import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ClusterView } from './api.service';
import { MeetingView } from './meeting.service';
import { MeetingReport } from './report.service';
import { ResolutionView, QuorumView } from './voting.service';

export interface SentimentAnalysis {
  category: 'Capital Allocation' | 'AI Strategy' | 'Executive Governance' | 'ESG & Climate' | 'Operations';
  sentiment: 'positive' | 'neutral' | 'critical';
  urgency: 'routine' | 'elevated' | 'critical';
  confidence: number;
}

export interface EnrichedClusterView extends ClusterView {
  sentimentData?: SentimentAnalysis;
}

@Injectable({ providedIn: 'root' })
export class DemoMeetingService {
  private readonly router = inject(Router);

  /** Whether the interactive demo AGM is currently active */
  readonly isDemoActive = signal<boolean>(false);

  /** Demo Meeting Metadata */
  readonly demoMeeting: MeetingView = {
    id: 'demo-agm-2026-apex',
    title: 'Apex Global Technologies — 2026 Annual Shareholder Meeting',
    description: 'Statutory AGM for FY2026: Financial Accounts, $500M Buyback Authorization, AI Capex Strategy & Director Appointments.',
    scheduledAt: new Date(Date.now() - 3600000).toISOString(),
    status: 'ACTIVE',
    active: true,
    createdBy: 'CorporateSecretary_Apex',
    activatedAt: new Date(Date.now() - 3600000).toISOString(),
    closedAt: null,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    memberCount: 2450,
    quorumThresholdPercent: 25.0,
  };

  /** Demo Quorum */
  readonly demoQuorum: QuorumView = {
    representedWeight: 16750000,
    totalWeight: 24500000,
    representedPercent: 68.36,
    thresholdPercent: 25.0,
    met: true,
  };

  /** Demo Resolutions */
  readonly demoResolutions: ResolutionView[] = [
    {
      id: 'res-demo-01',
      meetingId: 'demo-agm-2026-apex',
      seq: 1,
      title: 'Ordinary Resolution: Adoption of Audited FY2026 Financial Statements',
      text: 'To receive, consider and adopt the audited standalone and consolidated financial statements of the Company for the fiscal year ended March 31, 2026, together with the reports of the Board of Directors and Independent Auditors thereon.',
      type: 'ORDINARY',
      status: 'CLOSED',
      open: false,
      requiredMajorityPercent: 50.0,
      liveResultsVisible: true,
      result: {
        forWeight: 15711500,
        againstWeight: 1038500,
        abstainWeight: 250000,
        decisiveWeight: 16750000,
        forCount: 1840,
        againstCount: 95,
        abstainCount: 42,
        forPercent: 93.8,
        carried: true,
      },
      myChoice: 'FOR',
      openedAt: new Date(Date.now() - 3000000).toISOString(),
      closedAt: new Date(Date.now() - 1200000).toISOString(),
    },
    {
      id: 'res-demo-02',
      meetingId: 'demo-agm-2026-apex',
      seq: 2,
      title: 'Special Resolution: Authorization of $500M Share Buyback and Capital Allocation',
      text: 'RESOLVED THAT pursuant to applicable statutory provisions and Articles of Association, the Company be authorized to purchase up to $500,000,000 of its fully paid-up equity shares from open market operations.',
      type: 'SPECIAL',
      status: 'OPEN',
      open: true,
      requiredMajorityPercent: 75.0,
      liveResultsVisible: true,
      result: {
        forWeight: 13580000,
        againstWeight: 2650000,
        abstainWeight: 520000,
        decisiveWeight: 16230000,
        forCount: 1520,
        againstCount: 210,
        abstainCount: 68,
        forPercent: 83.67,
        carried: true,
      },
      myChoice: null,
      openedAt: new Date(Date.now() - 900000).toISOString(),
      closedAt: null,
    },
  ];

  /** Demo Clustered Questions with Sentiment & Citations */
  readonly demoClusters: EnrichedClusterView[] = [
    {
      cluster_id: 'cl-apex-01',
      representative_question: 'When will the FY2026 final dividend of $2.40 be paid out and what is the record date?',
      size: 14,
      priority_score: 9.8,
      draft: 'The Board of Directors has recommended a final dividend of $2.40 per equity share for FY2026. Subject to shareholder approval, the record date for entitlement is Friday, May 15, 2026, and direct disbursement will begin on Tuesday, June 2, 2026.',
      citations: [
        {
          source: 'apex-annual-report-2026.pdf p.18',
          snippet: 'Dividend Payout: Board recommends $2.40/share, payable June 2, 2026 to shareholders of record as of May 15, 2026.',
        },
      ],
      draft_status: 'DRAFTED',
      draft_error: null,
      answered_by: 'CFO_Apex',
      sentimentData: {
        category: 'Capital Allocation',
        sentiment: 'positive',
        urgency: 'routine',
        confidence: 0.94,
      },
    },
    {
      cluster_id: 'cl-apex-02',
      representative_question: 'What is the projected ROI and revenue timeline on the $1.2B hyperscale AI cloud infrastructure expansion?',
      size: 9,
      priority_score: 7.6,
      draft: 'Our cloud capex program is 70% contracted under 3-year minimum commitments with Fortune 500 enterprise customers, projecting 34% annualized operating margins beginning Q4 FY2026 with full capital recoupment by FY2028.',
      citations: [
        {
          source: 'apex-annual-report-2026.pdf p.34',
          snippet: 'Enterprise AI Cloud Capex: 3-year minimum capacity contracts secured, anticipated 34% operating margin by Q4 FY2026.',
        },
      ],
      draft_status: 'DRAFTED',
      draft_error: null,
      answered_by: null,
      sentimentData: {
        category: 'AI Strategy',
        sentiment: 'neutral',
        urgency: 'routine',
        confidence: 0.89,
      },
    },
    {
      cluster_id: 'cl-apex-03',
      representative_question: 'Can the governance committee address executive long-term incentive plan (LTIP) dilution under Resolution 4?',
      size: 6,
      priority_score: 6.2,
      draft: 'The Compensation Committee has structured the FY2026 LTIP with a strict 1.8% dilution ceiling over 4 years. 80% of vesting is strictly conditioned on total shareholder return (TSR) exceeding the 75th percentile of the benchmark index.',
      citations: [
        {
          source: 'governance-proxy-statement.pdf p.8',
          snippet: 'Executive LTIP Dilution Cap: 1.8% maximum equity pool, 80% performance-contingent on upper-quartile relative TSR.',
        },
      ],
      draft_status: 'DRAFTED',
      draft_error: null,
      answered_by: 'Chair_Remuneration',
      sentimentData: {
        category: 'Executive Governance',
        sentiment: 'critical',
        urgency: 'critical',
        confidence: 0.96,
      },
    },
    {
      cluster_id: 'cl-apex-04',
      representative_question: 'What are the interim milestones for reaching 100% renewable power in global datacenters before 2030?',
      size: 4,
      priority_score: 4.8,
      draft: 'Apex achieved 48% renewable energy sourcing across all primary datacenters in FY2026. Power purchase agreements (PPAs) already executed will bring this to 75% by December 2027, reaching 100% net-zero by 2030.',
      citations: [
        {
          source: 'apex-esg-report-2026.pdf p.12',
          snippet: 'Renewable Power Milestone: 48% current green sourcing, contracted PPAs reaching 75% in 2027 and 100% by 2030.',
        },
      ],
      draft_status: 'DRAFTED',
      draft_error: null,
      answered_by: null,
      sentimentData: {
        category: 'ESG & Climate',
        sentiment: 'positive',
        urgency: 'routine',
        confidence: 0.91,
      },
    },
  ];

  /** Demo Meeting Report */
  readonly demoReport: MeetingReport = {
    meetingId: 'demo-agm-2026-apex',
    title: 'Apex Global Technologies — 2026 Annual Shareholder Meeting',
    description: 'Statutory AGM for FY2026: Financial Accounts, $500M Buyback Authorization, AI Capex Strategy & Director Appointments.',
    status: 'ACTIVE',
    scheduledAt: new Date(Date.now() - 3600000).toISOString(),
    activatedAt: new Date(Date.now() - 3600000).toISOString(),
    closedAt: null,
    memberCount: 2450,
    totalVotingWeight: 24500000,
    quorum: {
      representedWeight: 16750000,
      totalWeight: 24500000,
      representedPercent: 68.36,
      thresholdPercent: 25.0,
      met: true,
    },
    resolutions: [
      {
        id: 'res-demo-01',
        seq: 1,
        title: 'Ordinary Resolution: Adoption of Audited FY2026 Financial Statements',
        text: 'To receive, consider and adopt the audited standalone and consolidated financial statements for FY2026.',
        type: 'ORDINARY',
        status: 'CLOSED',
        requiredMajorityPercent: 50.0,
        forWeight: 15711500,
        againstWeight: 1038500,
        abstainWeight: 250000,
        forCount: 1840,
        againstCount: 95,
        abstainCount: 42,
        forPercent: 93.8,
        carried: true,
        openedAt: new Date(Date.now() - 3000000).toISOString(),
        closedAt: new Date(Date.now() - 1200000).toISOString(),
      },
      {
        id: 'res-demo-02',
        seq: 2,
        title: 'Special Resolution: Authorization of $500M Share Buyback and Capital Allocation',
        text: 'Approval of $500,000,000 open-market share buyback and capital restructuring.',
        type: 'SPECIAL',
        status: 'OPEN',
        requiredMajorityPercent: 75.0,
        forWeight: 13580000,
        againstWeight: 2650000,
        abstainWeight: 520000,
        forCount: 1520,
        againstCount: 210,
        abstainCount: 68,
        forPercent: 83.67,
        carried: true,
        openedAt: new Date(Date.now() - 900000).toISOString(),
        closedAt: null,
      },
    ],
    answeredTopics: [
      {
        clusterId: 'cl-apex-01',
        question: 'When will the FY2026 final dividend of $2.40 be paid out and what is the record date?',
        askedHere: 14,
        weightHere: 850000,
        answer: 'The Board recommends $2.40/share. Record date May 15, 2026, payout June 2, 2026.',
        answeredBy: 'CFO_Apex',
        status: 'MANUAL',
        answered: true,
      },
      {
        clusterId: 'cl-apex-02',
        question: 'What is the projected ROI and revenue timeline on the $1.2B hyperscale AI cloud infrastructure expansion?',
        askedHere: 9,
        weightHere: 620000,
        answer: '70% capacity contracted on 3-year commitments, 34% operating margin by Q4 FY2026.',
        answeredBy: 'CEO_Apex',
        status: 'MANUAL',
        answered: true,
      },
    ],
    unansweredTopics: [
      {
        clusterId: 'cl-apex-03',
        question: 'Can the governance committee address executive long-term incentive plan (LTIP) dilution under Resolution 4?',
        askedHere: 6,
        weightHere: 430000,
        answer: null,
        answeredBy: null,
        status: 'PENDING',
        answered: false,
      },
      {
        clusterId: 'cl-apex-04',
        question: 'What are the interim milestones for reaching 100% renewable power in global datacenters before 2030?',
        askedHere: 4,
        weightHere: 280000,
        answer: null,
        answeredBy: null,
        status: 'PENDING',
        answered: false,
      },
    ],
    questionsAsked: 33,
    questionsNotAttributedToAnyMeeting: 0,
    generatedAt: new Date().toISOString(),
  };

  /** Sentiment overview breakdown */
  readonly sentimentSummary = computed(() => {
    const clusters = this.demoClusters;
    const total = clusters.reduce((acc, c) => acc + c.size, 0);
    const positive = clusters.filter(c => c.sentimentData?.sentiment === 'positive').reduce((acc, c) => acc + c.size, 0);
    const neutral = clusters.filter(c => c.sentimentData?.sentiment === 'neutral').reduce((acc, c) => acc + c.size, 0);
    const critical = clusters.filter(c => c.sentimentData?.sentiment === 'critical').reduce((acc, c) => acc + c.size, 0);

    return {
      totalQuestions: total,
      distinctTopics: clusters.length,
      noiseReductionPercent: Math.round(((total - clusters.length) / total) * 100),
      positivePercent: Math.round((positive / total) * 100),
      neutralPercent: Math.round((neutral / total) * 100),
      criticalPercent: Math.round((critical / total) * 100),
    };
  });

  /** Activate the demo mode and route to the board */
  launchDemoMeeting(targetRoute: string = '/board') {
    this.isDemoActive.set(true);
    this.router.navigate([targetRoute]);
  }

  /** Reset demo mode */
  resetDemo() {
    this.isDemoActive.set(false);
  }
}
