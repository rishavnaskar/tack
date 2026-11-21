import type {
  AppState,
  AppStatus,
  Application,
  ApplicationDetails,
  ApplyBatch,
  ApplyReadiness,
  ApplyRun,
  DetailsView,
  MailStatus,
  SyncResult,
  GapMap,
  Goal,
  InterviewSession,
  InterviewTurn,
  Kit,
  Plan,
  PortfolioProject,
  Posting,
  Profile,
  Progress,
  TrackerInsights,
} from './types';

export const MOCK = import.meta.env.VITE_MOCK === '1' || import.meta.env.MODE === 'mock';
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export class ApiError extends Error {
  status: number;
  path: string;
  constructor(status: number, message: string, path: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Transport = (method: Method, path: string, body?: unknown) => Promise<unknown>;

const onThisMachine = () => typeof location === 'undefined' || /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname);

function unreachable(): string {
  return onThisMachine()
    ? 'Could not reach the coach server. Check that it is running on port 4400.'
    : 'Could not reach Tack. Check your connection and try again.';
}

// The first request goes out alone. On the web preview its answer sets the session cookie, and
// requests sent before it lands would each start a session of their own.
let first: Promise<unknown> | null = null;

const http: Transport = async (method, path, body) => {
  const send = () =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res: Response;
  try {
    if (!first) {
      const p = send();
      first = p.catch(() => undefined);
      res = await p;
    } else {
      await first;
      res = await send();
    }
  } catch {
    throw new ApiError(0, unreachable(), path);
  }
  const type = res.headers.get('content-type') ?? '';
  const data: unknown = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    if (res.status >= 500 && !type.includes('json')) {
      throw new ApiError(res.status, unreachable(), path);
    }
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : res.status === 429
          ? 'Tack is busy right now. Wait a minute and try again.'
          : `Request failed with ${res.status}`;
    throw new ApiError(res.status, msg, path);
  }
  return data;
};

let mockTransport: Promise<Transport> | null = null;

function transport(): Promise<Transport> {
  if (MOCK) {
    mockTransport ??= import('./mock').then((m) => m.createMockTransport());
    return mockTransport;
  }
  return Promise.resolve(http);
}

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const t = await transport();
  return (await t(method, path, body)) as T;
}

export interface RoleSuggestion {
  role: string;
  overlap: number;
  why: string;
}

export interface BriefItem {
  kind: string;
  text: string;
  action?: string;
}

export interface Brief {
  headline: string;
  items: BriefItem[];
}

export type ResumeInput = { text: string } | { pdfBase64: string; filename: string };

/** One function per route in docs/SPEC.md. */
export const api = {
  state: () => call<AppState>('GET', '/state'),
  loadDemo: () => call<AppState>('POST', '/demo/load'),
  reset: () => call<AppState>('POST', '/reset'),

  uploadResume: (input: ResumeInput) => call<Profile>('POST', '/profile/resume', input),
  saveProfile: (profile: Profile) => call<Profile>('PUT', '/profile', profile),
  saveGoal: (goal: Goal) => call<Goal>('PUT', '/goal', goal),
  suggestRoles: () => call<{ roles: RoleSuggestion[] }>('POST', '/roles/suggest'),

  harvest: (count = 40) => call<{ postings: Posting[]; live: boolean }>('POST', '/postings/harvest', { count }),
  postings: () => call<Posting[]>('GET', '/postings'),

  buildGap: () => call<GapMap>('POST', '/gap/build'),
  gap: () => call<GapMap>('GET', '/gap'),

  buildPlan: () => call<Plan>('POST', '/plan/build'),
  plan: () => call<Plan>('GET', '/plan'),
  setTaskStatus: (taskId: string, status: 'todo' | 'done' | 'skipped') =>
    call<{ plan: Plan; progress: Progress }>('PATCH', `/plan/tasks/${encodeURIComponent(taskId)}`, { status }),
  checkpoint: (week: number, passed: boolean) => call<Plan>('POST', `/plan/checkpoint/${week}`, { passed }),
  replan: (reason?: string) => call<Plan>('POST', '/plan/replan', reason ? { reason } : {}),
  calendar: () => call<string>('GET', '/plan/calendar.ics'),
  calendarUrl: () => `${API_BASE}/plan/calendar.ics`,

  buildPortfolio: () => call<PortfolioProject[]>('POST', '/portfolio/build'),
  portfolio: () => call<PortfolioProject[]>('GET', '/portfolio'),
  setProjectStatus: (id: string, status: PortfolioProject['status']) =>
    call<PortfolioProject>('PATCH', `/portfolio/${encodeURIComponent(id)}`, { status }),

  startInterview: (kind: InterviewSession['kind'], postingId?: string) =>
    call<InterviewSession>('POST', '/interviews', postingId ? { kind, postingId } : { kind }),
  answer: (sessionId: string, questionId: string, answer: string) =>
    call<{ turn: InterviewTurn; session: InterviewSession }>('POST', `/interviews/${encodeURIComponent(sessionId)}/answer`, {
      questionId,
      answer,
    }),
  interviews: () => call<InterviewSession[]>('GET', '/interviews'),

  applications: () => call<Application[]>('GET', '/applications'),
  addApplication: (app: Partial<Application>) => call<Application>('POST', '/applications', app),
  setApplicationStatus: (id: string, status: AppStatus, note?: string) =>
    call<Application>('PATCH', `/applications/${encodeURIComponent(id)}`, note ? { status, note } : { status }),
  syncApplications: () => call<SyncResult>('POST', '/applications/sync'),
  insights: () => call<TrackerInsights>('GET', '/tracker/insights'),
  apply: (postingIds: string[]) => call<{ started: boolean; note: string; batch: ApplyBatch }>('POST', '/apply', { postingIds }),
  applyTop: (n: number) => call<{ started: boolean; note: string; batch: ApplyBatch }>('POST', '/apply/top', { n }),
  applyBatch: (id: string) => call<ApplyBatch>('GET', `/apply/batches/${encodeURIComponent(id)}`),
  applyRuns: () => call<ApplyRun[]>('GET', '/apply/runs'),
  readiness: (postingId?: string) => call<ApplyReadiness>('GET', `/apply/readiness${postingId ? `?postingId=${encodeURIComponent(postingId)}` : ''}`),
  details: () => call<DetailsView>('GET', '/details'),
  saveDetails: (d: ApplicationDetails) => call<DetailsView>('PUT', '/details', d),
  mailStatus: () => call<MailStatus>('GET', '/mail/status'),
  mailConnect: () => call<{ url: string }>('POST', '/mail/connect'),
  mailCheck: () => call<MailStatus>('POST', '/mail/check'),

  progress: () => call<Progress>('GET', '/progress'),
  brief: () => call<Brief>('GET', '/brief'),

  eventsUrl: () => `${API_BASE}/events`,

  kit: (postingId: string) => call<Kit>('GET', `/kit/${encodeURIComponent(postingId)}`),
  buildKit: (postingId: string, fresh = false) => call<Kit>('POST', `/kit/${encodeURIComponent(postingId)}${fresh ? '?fresh=1' : ''}`),
  setDeliverables: (id: string, deliverablesDone: string[]) =>
    call<PortfolioProject>('PATCH', `/portfolio/${encodeURIComponent(id)}`, { deliverablesDone }),
};

/** Reads a File as base64 without the data: prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}
