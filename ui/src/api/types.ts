export type Level = 'strong' | 'partial' | 'missing';
export interface ProfileSkill { id: string; name: string; level: number; evidence: string[] } // level 1-5
export interface Role { title: string; company: string; start: string; end: string; bullets: string[] }
export interface Profile {
  name: string; headline: string; currentRole: string; yearsExperience: number; summary: string;
  skills: ProfileSkill[]; experience: Role[]; education: string[]; projects: string[];
  source: 'pdf' | 'text' | 'demo';
}
export interface Goal {
  targetRole: string; location: string; remote: boolean;
  hoursPerWeek: number; weeks: number; startDate: string; notes: string;
}
export interface Posting {
  id: string; title: string; company: string; location: string; url: string; source: string;
  postedAt?: string; salary?: string; text: string; harvestedAt: string; live: boolean;
  roleFamily?: string; seniority?: string; companySize?: 'startup' | 'scaleup' | 'enterprise';
  skills?: { skillId: string; name: string; importance: 'must' | 'nice'; quote: string }[];
  fit?: number; // 0-100 against the profile
}
export interface GapSkill {
  id: string; name: string; category: string;
  demand: number;        // share of postings asking for it, 0-1
  mustShare: number;     // share listing it as a must
  level: Level; have: number; need: number; // have 0-5, need 1-5
  evidence: { resume: string[]; postings: { postingId: string; company: string; quote: string }[] };
  bridge?: { from: string; note: string }; // skill the person has that transfers
  priority: number;      // 0-100, demand x gap
  status: 'open' | 'learning' | 'closed';
}
export interface GapMap {
  postingCount: number; generatedAt: string; readiness: number; // demand-weighted coverage 0-100
  skills: GapSkill[]; summary: string;
  market: { topCompanies: { name: string; count: number }[]; locations: { name: string; count: number }[];
            seniority: { name: string; count: number }[]; salaryNote: string };
}
export interface PlanTask {
  id: string; title: string; kind: 'learn' | 'practice' | 'project' | 'interview' | 'apply';
  skillIds: string[]; hours: number; resource?: { title: string; url: string; verified: boolean };
  status: 'todo' | 'done' | 'skipped'; doneAt?: string;
}
export interface PlanWeek {
  index: number; startDate: string; theme: string; skillIds: string[]; hours: number;
  tasks: PlanTask[]; checkpoint: { title: string; description: string; passed?: boolean };
}
export interface PlanChange { at: string; reason: string; summary: string; moved: string[] }
export interface Plan { version: number; createdAt: string; weeks: PlanWeek[]; changes: PlanChange[] }
export interface PortfolioProject {
  id: string; title: string; pitch: string; skillIds: string[]; brief: string;
  milestones: { title: string; week: number }[]; deliverables: string[]; reviewerSees: string;
  postingQuotes: { company: string; quote: string }[]; status: 'idea' | 'building' | 'shipped';
  deliverablesDone?: string[]; // deliverable texts ticked off
}
export interface RubricScore { criterion: string; score: number; why: string; quote?: string } // 1-5
export interface InterviewQuestion { id: string; kind: 'behavioural' | 'technical' | 'case'; text: string; skillIds: string[]; fromPosting?: string }
export interface InterviewTurn {
  questionId: string; answer: string; scores: RubricScore[]; overall: number; // 0-100
  strengths: string[]; fixes: string[]; betterAnswer: string; followUp?: string; at: string;
}
export interface InterviewSession {
  id: string; kind: 'behavioural' | 'technical' | 'case' | 'mixed'; postingId?: string;
  questions: InterviewQuestion[]; turns: InterviewTurn[]; score?: number; startedAt: string; finishedAt?: string;
}
export type AppStatus = 'applied' | 'viewed' | 'reply' | 'interview' | 'offer' | 'rejected' | 'ghosted';
export interface Application {
  id: string; postingId?: string; title: string; company: string; url: string;
  roleFamily: string; seniority: string; companySize: string; source: string; fit: number;
  appliedAt: string; status: AppStatus; lastEventAt: string;
  events: { at: string; kind: string; note: string }[]; origin: 'fanfold' | 'manual' | 'demo';
}
export interface Segment { dimension: string; value: string; sent: number; responses: number; rate: number; lift: number; confidence: 'low' | 'medium' | 'high' }
export interface TrackerInsights {
  overall: { sent: number; responses: number; rate: number };
  segments: Segment[]; lessons: string[];
  next: { postingId: string; title: string; company: string; url: string; fit: number; responseChance: number; why: string }[];
}
export interface Progress {
  readiness: { at: string; value: number }[]; hoursDone: number; hoursPlanned: number;
  tasksDone: number; tasksTotal: number; skillsClosed: number; interviewAvg: { at: string; value: number }[];
  streakDays: number; onTrack: boolean; note: string;
}
export interface TraceEvent { id: string; at: string; run: string; step: string; detail: string; status: 'start' | 'ok' | 'fail'; ms?: number }
export interface AppState {
  mode: 'demo' | 'live'; engine: { available: boolean; note: string };
  model: { configured: boolean; name: string };
  profile?: Profile; goal?: Goal; counts: { postings: number; applications: number; interviews: number };
  has: { gap: boolean; plan: boolean; portfolio: boolean };
}
export interface Kit {
  postingId: string; generatedAt: string; fit: number; headline: string;
  bullets: { text: string; basedOn: string }[]; // basedOn is a verbatim line from the profile
  coverNote: string; talkingPoints: string[];
  gapsToAddress: { skill: string; howToFrame: string }[]; questionsToAsk: string[];
}

export type MailKind = 'interview' | 'reply' | 'rejected' | 'offer' | 'auto-ack' | 'unrelated';
export interface MailChange {
  company: string; title: string; applicationId: string; from: AppStatus; to: AppStatus;
  subject: string; sender: string; at: string; kind: MailKind;
}
export interface SyncResult {
  added: number; updated: number; note: string; source: 'sample' | 'gmail' | 'none';
  searched: number; messages: number; classified: Partial<Record<MailKind, number>>; by: 'model' | 'rules' | 'none';
  changes: MailChange[]; ms: number;
}
export interface MailStatus {
  source: 'sample' | 'gmail' | 'none'; connected: boolean; label: string; note: string;
  canConnect: boolean; engine: 'own' | 'attach' | 'off';
}
export interface ApplicationDetails {
  fullName: string; email: string; phone: string; city: string; linkedin: string;
  workAuthorisation: string; noticePeriod: string; updatedAt?: string;
}
export interface ApplyStep { at: string; kind: 'open' | 'form' | 'fill' | 'upload' | 'next' | 'submit' | 'confirm' | 'note' | 'error'; label: string }
export interface ApplyRun {
  id: string; batchId: string; postingId: string; company: string; title: string;
  target: 'practice' | 'live'; url: string; session: string;
  status: 'queued' | 'running' | 'applied' | 'failed';
  steps: ApplyStep[]; fields: number; confirmation?: string; reference?: string; reason?: string;
  applicationId?: string; startedAt: string; endedAt?: string; ms?: number;
  /** A picture of the engine's page when the run ended. */
  shot?: boolean;
}
export interface ApplyBatch { id: string; startedAt: string; endedAt?: string; ms?: number; runs: ApplyRun[]; note?: string }
export interface ApplyReadiness { ready: boolean; missing: string[]; reason: string; target: 'practice' | 'live' }
export interface DetailsView {
  details: ApplicationDetails; resume: { filename: string; mime: string; savedAt: string } | null; readiness: ApplyReadiness;
  problems?: Record<string, string>;
}
