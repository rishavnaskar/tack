/**
 * The shape of every request body the API accepts.
 *
 * Limits are generous for a person typing and tight for anything else: a
 * local UI never needs a megabyte of goal text, and an unbounded string is
 * how a local server ends up holding one.
 */

import { array, boolean, nullable, number, object, oneOf, optional, record, string } from './schema.ts';
import { APPLICATION_STATUSES } from '../jobs/jobs.ts';
import { GATEABLE } from '../policy/engine.ts';

const id = string({ max: 100, pattern: /^[\w-]+$/ });
const text = (max: number) => optional(string({ max }));
const strings = (maxItems: number, maxLength: number) => optional(array(string({ max: maxLength }), { max: maxItems }));

export const Task = object({
  goal: text(20_000),
  maxSteps: optional(number({ int: true, min: 1, max: 200 })),
  conversationId: optional(id),
});

export const RenameConversation = object({ title: text(200) });

export const Approval = object({ editedContent: text(100_000), note: text(2_000) });

export const Document = object({
  title: text(300),
  base64: text(40_000_000),
  text: text(5_000_000),
  mime: text(200),
  /** Imported as the résumé: it replaces the one before, and a file that is not a résumé is refused as one. */
  resume: optional(boolean()),
});

/** "This is mine": `anyway` when the file carries somebody else's name; `resume` to make it the résumé too. */
export const DocumentMine = object({ anyway: optional(boolean()), resume: optional(boolean()) });

export const Grant = object({
  label: text(200),
  workerId: nullable(id),
  domains: strings(50, 253),
  sensitivities: optional(array(oneOf(GATEABLE), { max: GATEABLE.length })),
  actionKinds: strings(20, 40),
  recipients: strings(100, 300),
  maxUses: nullable(number({ int: true, min: 1, max: 1_000_000 })),
  expiresInHours: nullable(number({ min: 0, max: 24 * 366 })),
});

export const ConnectorStart = object({ allowDrafting: optional(boolean()), toolkit: text(64) });

const Mandate = object({
  roles: strings(20, 200),
  seniority: strings(10, 60),
  locations: strings(20, 200),
  remote: strings(5, 60),
  salaryFloor: nullable(string({ max: 100 })),
  postingAgeDays: nullable(number({ int: true, min: 0, max: 365 })),
  exclusions: strings(50, 200),
});

export const Worker = object({
  name: text(120),
  goal: text(4_000),
  times: strings(12, 5),
  days: optional(array(number({ int: true, min: 0, max: 6 }), { max: 7 })),
  timezone: text(64),
  preferOffPeak: optional(boolean()),
  maxSteps: optional(number({ int: true, min: 1, max: 200 })),
  mandate: optional(Mandate),
  sites: optional(array(object({
    site: string({ max: 40 }),
    enabled: optional(boolean()),
    dailyCap: optional(number({ int: true, min: 0, max: 500 })),
  }), { max: 50 })),
  autonomy: optional(oneOf(['review_all', 'auto_known', 'auto_within_caps'] as const)),
  caps: optional(object({
    dailyTotal: optional(number({ int: true, min: 0, max: 500 })),
    dailySpendUsd: nullable(number({ min: 0, max: 1_000 })),
  })),
  documents: optional(object({
    resumeId: nullable(string({ max: 100 })),
    coverLetterPolicy: optional(oneOf(['when_required', 'always', 'never'] as const)),
  })),
  browserMode: optional(oneOf(['dedicated', 'extension', 'auto'] as const)),
  conversationId: optional(id),
  enable: optional(boolean()),
});

const AnswerBody = object({
  question: string({ max: 300 }),
  answer: string({ max: 4_000 }),
  source: optional(string({ max: 20 })),
});

export const AddApplication = object({ url: text(2_000), company: text(160), title: text(200), again: optional(boolean()) });

export const UpdateApplication = object({
  status: optional(oneOf(APPLICATION_STATUSES)),
  skipReason: text(300),
  answers: optional(array(AnswerBody, { max: 100 })),
  saveToBank: optional(boolean()),
});

export const SubmitApplication = object({
  answers: optional(array(AnswerBody, { max: 100 })),
  saveToBank: optional(boolean()),
  all: optional(boolean()),
});

/** Removing an application: `sent` is the owner's second yes, for one that was sent, that Fanfold's record of it goes too. */
export const RemoveApplication = object({ sent: optional(boolean()) });

export const Profile = object({ fields: optional(record(string({ max: 20_000 }), { maxKeys: 30, maxKeyLength: 40 })) });

/** One country the person may work in, as the picker sends it; what each part may be is checked in jobs/work-rights.ts, in words. */
const RightsEntryBody = object({
  id: optional(string({ max: 40 })),
  country: optional(string({ max: 200 })),
  status: optional(string({ max: 40 })),
  validUntil: nullable(string({ max: 20 })),
  note: nullable(string({ max: 2_000 })),
  sponsorship: nullable(string({ max: 20 })),
});

/** Where the person may work: the whole list, and the answer for anywhere else. */
export const Rights = object({ entries: optional(array(RightsEntryBody, { max: 40 })), elsewhere: nullable(oneOf(['need', 'skip'] as const)) });

/** One country from the answer dialog, in place of any entry for it; `replacesAnswer` is the saved answer it was opened from. */
export const RightsEntry = object({ entry: RightsEntryBody, elsewhere: nullable(oneOf(['need', 'skip'] as const)), replacesAnswer: optional(number({ int: true, min: 1 })) });

/** "Later" on a setup reminder. Out of range is held to the range rather than refused. */
export const SetupSnooze = object({ hours: optional(number()) });

/** The person's own Gemini key, as pasted. Its own checks are in model/source.ts. */
export const ModelKey = object({ key: string({ max: 2_000 }) });

/** A Firebase ID token, handed over once after the page signed in, and where the person started. */
export const AuthSession = object({ idToken: string({ min: 1, max: 16_000 }), from: optional(oneOf(['claude', 'app'] as const)) });

export const Answer = object({ question: text(20_000), answer: text(100_000) });

export const QuestionAnswer = object({ answer: text(4_000), forEveryCompany: optional(boolean()) });

export const SettleEffect = object({ went: boolean() });

export const SitePosture = object({
  submit: optional(oneOf(['auto', 'prepare', 'never'] as const)),
  acceptTerms: optional(boolean()),
  dailyCap: optional(number({ int: true, min: 0, max: 100 })),
});

export const Settings = object({
  contributeLessons: optional(boolean()),
  submitWithoutAsking: optional(boolean()),
  mailCodes: optional(boolean()),
  browserMode: optional(oneOf(['dedicated', 'extension', 'auto'] as const)),
});

export const TeachStart = object({ url: optional(string({ max: 2_000 })) });

export const TeachStop = object({ save: boolean(), name: optional(string({ max: 80 })) });

export const OpenUrl = object({ url: text(2_000), applicationId: optional(string({ max: 64 })) });

/** "Stop Fanfold here" on one of the tabs Fanfold is using. */
export const StopTab = object({ targetId: string({ max: 200, pattern: /^[\w.:-]+$/ }) });
