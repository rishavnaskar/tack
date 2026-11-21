import { api, ApiError, type Brief, type ResumeInput } from './client';
import { tracked } from './events';
import { clearCache, fetchQuery, getQueryData, invalidate, setQueryData, useQuery } from './query';
import type {
  AppState,
  AppStatus,
  Application,
  GapMap,
  Goal,
  InterviewSession,
  Kit,
  Plan,
  PortfolioProject,
  Posting,
  Profile,
  Progress,
  TrackerInsights,
} from './types';

export const keys = {
  state: 'state',
  postings: 'postings',
  gap: 'gap',
  plan: 'plan',
  portfolio: 'portfolio',
  interviews: 'interviews',
  applications: 'applications',
  insights: 'insights',
  progress: 'progress',
  brief: 'brief',
} as const;

export const kitKey = (postingId: string) => `kit:${postingId}`;

/** A 404 on a GET means "not built yet"; surface it as null, not an error. */
function orNull<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
}

export const useAppState = () => useQuery<AppState>(keys.state, api.state);
export const usePostings = () => useQuery<Posting[]>(keys.postings, api.postings);
/** Skips the request (and its 404 in the console) when the state already says it is not built. */
async function ifBuilt<T>(what: 'gap' | 'plan', get: () => Promise<T>): Promise<T | null> {
  const s = getQueryData<AppState>(keys.state) ?? (await fetchQuery<AppState>(keys.state, api.state).catch(() => undefined));
  if (s && !s.has[what]) return null;
  return orNull(get());
}

export const useGap = () => useQuery<GapMap | null>(keys.gap, () => ifBuilt('gap', api.gap));
export const usePlan = () => useQuery<Plan | null>(keys.plan, () => ifBuilt('plan', api.plan));
export const usePortfolio = () => useQuery<PortfolioProject[]>(keys.portfolio, api.portfolio);
export const useInterviews = () => useQuery<InterviewSession[]>(keys.interviews, api.interviews);
export const useApplications = () => useQuery<Application[]>(keys.applications, api.applications);
export const useInsights = () => useQuery<TrackerInsights>(keys.insights, api.insights);
export const useProgress = () => useQuery<Progress>(keys.progress, api.progress);
export const useBrief = () => useQuery<Brief>(keys.brief, api.brief);
/** Builds the kit on first open (or returns the server's cached one), through the trace rail. */
export const useKit = (postingId?: string) =>
  useQuery<Kit>(
    kitKey(postingId ?? ''),
    () => (postingId ? tracked('Preparing the application', () => api.buildKit(postingId)) : Promise.reject(new Error('No posting picked'))),
    { enabled: !!postingId },
  );

function patchState(fn: (s: AppState) => AppState) {
  setQueryData<AppState>(keys.state, (s) => (s ? fn(s) : (s as unknown as AppState)));
}

/**
 * Calls that change server state. Each one updates or invalidates the cache keys it
 * touches, so screens re-render without their own bookkeeping. Long calls go through
 * `tracked`, which opens the trace rail and pulses the activity dot.
 */
export const actions = {
  async loadDemo() {
    const s = await tracked('Loading the demo person', api.loadDemo, { open: false });
    clearCache();
    setQueryData(keys.state, s);
    return s;
  },

  async reset() {
    const s = await api.reset();
    clearCache();
    setQueryData(keys.state, s);
    return s;
  },

  async uploadResume(input: ResumeInput) {
    const profile = await tracked('Reading the résumé', () => api.uploadResume(input));
    patchState((s) => ({ ...s, profile }));
    return profile;
  },

  async saveProfile(profile: Profile) {
    const saved = await api.saveProfile(profile);
    patchState((s) => ({ ...s, profile: saved }));
    return saved;
  },

  async saveGoal(goal: Goal) {
    const saved = await api.saveGoal(goal);
    patchState((s) => ({ ...s, goal: saved }));
    return saved;
  },

  suggestRoles: api.suggestRoles,

  async harvest(count = 40) {
    const res = await tracked('Reading postings', () => api.harvest(count));
    setQueryData(keys.postings, res.postings);
    patchState((s) => ({ ...s, mode: res.live ? 'live' : s.mode, counts: { ...s.counts, postings: res.postings.length } }));
    // Live postings can switch the mode (demo person, real market); the server has the final word.
    invalidate(keys.state);
    return res;
  },

  async buildGap() {
    const gap = await tracked('Building the gap map', api.buildGap);
    setQueryData(keys.gap, gap);
    patchState((s) => ({ ...s, has: { ...s.has, gap: true } }));
    invalidate(keys.postings, keys.progress, keys.brief);
    return gap;
  },

  async buildPlan() {
    const plan = await tracked('Planning the weeks', api.buildPlan);
    setQueryData(keys.plan, plan);
    patchState((s) => ({ ...s, has: { ...s.has, plan: true } }));
    invalidate(keys.progress, keys.brief);
    return plan;
  },

  async setTaskStatus(taskId: string, status: 'todo' | 'done' | 'skipped') {
    const { plan, progress } = await api.setTaskStatus(taskId, status);
    setQueryData(keys.plan, plan);
    setQueryData(keys.progress, progress);
    invalidate(keys.brief);
    return plan;
  },

  async checkpoint(week: number, passed: boolean) {
    const plan = await api.checkpoint(week, passed);
    setQueryData(keys.plan, plan);
    invalidate(keys.progress, keys.brief);
    return plan;
  },

  async replan(reason?: string) {
    const plan = await tracked('Replanning', () => api.replan(reason));
    setQueryData(keys.plan, plan);
    invalidate(keys.progress, keys.brief);
    return plan;
  },

  async buildPortfolio() {
    const projects = await tracked('Drafting portfolio projects', api.buildPortfolio);
    setQueryData(keys.portfolio, projects);
    patchState((s) => ({ ...s, has: { ...s.has, portfolio: true } }));
    return projects;
  },

  async setProjectStatus(id: string, status: PortfolioProject['status']) {
    const project = await api.setProjectStatus(id, status);
    setQueryData<PortfolioProject[]>(keys.portfolio, (all) => (all ?? []).map((p) => (p.id === id ? project : p)));
    return project;
  },

  async startInterview(kind: InterviewSession['kind'], postingId?: string) {
    const session = await tracked('Writing interview questions', () => api.startInterview(kind, postingId));
    setQueryData<InterviewSession[]>(keys.interviews, (all) => [session, ...(all ?? []).filter((s) => s.id !== session.id)]);
    return session;
  },

  async answer(sessionId: string, questionId: string, answer: string) {
    const res = await tracked('Scoring the answer', () => api.answer(sessionId, questionId, answer));
    setQueryData<InterviewSession[]>(keys.interviews, (all) => (all ?? []).map((s) => (s.id === sessionId ? res.session : s)));
    invalidate(keys.progress);
    return res;
  },

  async addApplication(app: Partial<Application>) {
    const created = await api.addApplication(app);
    setQueryData<Application[]>(keys.applications, (all) => [created, ...(all ?? [])]);
    invalidate(keys.insights, keys.state);
    return created;
  },

  async setApplicationStatus(id: string, status: AppStatus, note?: string) {
    const updated = await api.setApplicationStatus(id, status, note);
    setQueryData<Application[]>(keys.applications, (all) => (all ?? []).map((a) => (a.id === id ? updated : a)));
    invalidate(keys.insights);
    return updated;
  },

  async syncApplications() {
    const res = await tracked('Syncing applications', api.syncApplications);
    invalidate(keys.applications, keys.insights);
    return res;
  },

  async apply(postingId: string) {
    const res = await api.apply(postingId);
    if (res.started) invalidate(keys.applications, keys.insights);
    return res;
  },

  async rebuildKit(postingId: string) {
    const kit = await tracked('Rewriting the application kit', () => api.buildKit(postingId, true));
    setQueryData(kitKey(postingId), kit);
    return kit;
  },

  async setDeliverables(id: string, deliverablesDone: string[]) {
    const project = await api.setDeliverables(id, deliverablesDone);
    setQueryData<PortfolioProject[]>(keys.portfolio, (all) => (all ?? []).map((p) => (p.id === id ? project : p)));
    return project;
  },

  /** Harvest then gap build, as one run. */
  async readMarket(count = 40) {
    return tracked('Reading the market', async () => {
      const harvest = await actions.harvest(count);
      const gap = await actions.buildGap();
      return { harvest, gap };
    });
  },
};
