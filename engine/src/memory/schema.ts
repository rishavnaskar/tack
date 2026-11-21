/**
 * The four memory stores.
 *
 * The common mistake is to put all of this behind one vector index. Only one
 * of the four wants fuzzy matching:
 *
 *  - skills      — induced, parameterised trajectories. Keyed by (domain, intent).
 *  - lessons     — what went wrong and what to do instead. Fuzzy recall helps.
 *  - episodic    — who was contacted, when, about what. EXACT keys, never fuzzy.
 *  - documents   — the user's resume, PDFs, writing samples. Retrieval.
 *
 * The episodic store is the one that has to be exact, and it is worth being
 * explicit about why: its whole job is "never surface or contact the same
 * person twice". A similarity threshold will eventually rank two different
 * people as the same, or the same person as two — and the failure mode is
 * messaging a prospect twice, which is precisely the mistake that destroys
 * trust in the product. So identity is a unique constraint, not a distance.
 */

export const MEMORY_SCHEMA = `
-- ---------------------------------------------------------------- skills
CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  intent        TEXT NOT NULL,
  params        TEXT NOT NULL,          -- JSON array of parameter names
  steps         TEXT NOT NULL,          -- JSON array of steps with checkpoints
  status        TEXT NOT NULL,          -- proposed | shadow | active | quarantined | retired
  version       INTEGER NOT NULL DEFAULT 1,
  runs          INTEGER NOT NULL DEFAULT 0,
  successes     INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  created_at    TEXT NOT NULL,
  last_ok_at    TEXT,
  last_error    TEXT,
  induced_from  TEXT                    -- run id this was learned from
);
CREATE INDEX IF NOT EXISTS skills_lookup ON skills(domain, intent, status);

-- ---------------------------------------------------------------- lessons
-- Append-only. A lesson is never rewritten in place: evolving a context by
-- rewriting it is how these systems collapse their own memory over time.
-- Superseding is done by writing a new row that supersedes an older id.
CREATE TABLE IF NOT EXISTS lessons (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  task_type     TEXT NOT NULL,
  trigger       TEXT NOT NULL,          -- the observable situation
  lesson        TEXT NOT NULL,          -- what to do instead
  evidence_run  TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,
  uses          INTEGER NOT NULL DEFAULT 0,
  helped        INTEGER NOT NULL DEFAULT 0,
  supersedes    TEXT,
  retired       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  -- Lifecycle. A lesson the reflector just wrote is 'proposed' and is NOT
  -- recalled at runtime: connecting recall to raw reflector output would put
  -- ungated conclusions into every subsequent run on that site.
  --   proposed  - written, never measured
  --   shadow    - being trialled, recalled only when explicitly asked for
  --   active    - measured and promoted; the only state recall returns
  --   unproven  - measured, no detectable effect; stays out until shadowed
  --   rejected  - measured and harmful, or refused by the safety screen
  status        TEXT NOT NULL DEFAULT 'proposed',
  gate_verdict  TEXT,                   -- why the gate decided what it did
  gated_at      TEXT,
  shadow_runs   INTEGER NOT NULL DEFAULT 0,
  shadow_successes INTEGER NOT NULL DEFAULT 0,
  -- Content identity. Reflection runs repeatedly over overlapping windows of
  -- runs; without this the same conclusion accumulates duplicate rows and the
  -- gate re-decides it, including re-proposing what it already rejected.
  fingerprint   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS lessons_fingerprint ON lessons(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS lessons_lookup ON lessons(domain, task_type, status, retired);

-- What has already been reflected on, so a restart does not reflect on the
-- same runs again and spend a full eval suite per candidate for nothing.
-- The watermark is a COMPLETION position, not a start position. A run that
-- began first can finish last, and a start-ordered watermark skips it
-- forever: a browser task running for hours would never reach memory or the
-- evals. Ordered by (ended_at, id) so ties are still total.
CREATE TABLE IF NOT EXISTS learning_state (
  id                TEXT PRIMARY KEY,
  last_run_id       TEXT,
  last_run_started_at TEXT,
  last_run_ended_at TEXT,
  passes            INTEGER NOT NULL DEFAULT 0,
  last_pass_at      TEXT
);

-- What each site's knowledge file held when Fanfold last wrote it, so a line
-- the person deleted can be told from a note learned since.
CREATE TABLE IF NOT EXISTS knowledge_files (
  host        TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  notes       TEXT NOT NULL,          -- JSON array of lesson fingerprints written
  written_at  TEXT NOT NULL
);

-- --------------------------------------------------------------- episodic
-- identity_key is the natural key of a person or company: a profile URL, an
-- email, a normalised company domain. UNIQUE is the entire point of the table.
CREATE TABLE IF NOT EXISTS episodic (
  identity_key  TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,          -- person | company
  display_name  TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  contacted_at  TEXT,
  contact_channel TEXT,
  contact_content TEXT,
  outcome       TEXT,
  screened_out  INTEGER NOT NULL DEFAULT 0,
  screened_reason TEXT,
  run_id        TEXT
);
CREATE INDEX IF NOT EXISTS episodic_contacted ON episodic(contacted_at);

-- Every contact after the first, which episodic.contacted_at records and
-- never overwrites. A person approves each of these knowingly.
CREATE TABLE IF NOT EXISTS contact_repeats (
  identity_key  TEXT NOT NULL,
  at            TEXT NOT NULL,
  channel       TEXT,
  content       TEXT
);
CREATE INDEX IF NOT EXISTS contact_repeats_identity ON contact_repeats(identity_key);

-- -------------------------------------------------------------- documents
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  -- Where it came from. Kept for provenance only: it may be edited, moved or
  -- replaced after import, so it is never what gets attached to anything.
  source_path   TEXT,
  -- The app's own retained copy, written once at import and never touched
  -- again. This is what an upload attaches, so the file that goes out is the
  -- one whose text was indexed and shown to the user.
  file_path     TEXT,
  file_sha256   TEXT,
  mime          TEXT,
  added_at      TEXT NOT NULL,
  bytes         INTEGER,
  -- Who put it here: NULL is the owner, through Fanfold's own screen, as is
  -- every row from before this was recorded; otherwise the outside agent that did.
  imported_by   TEXT,
  -- Why a file an outside agent imported waits for the owner's OK. While it
  -- is set, nothing reads, searches or attaches the file. NULL once allowed.
  held_why      TEXT,
  -- 1 when the owner imported it or said it is theirs: only then may what it
  -- says about them answer an application. An agent's import starts at 0.
  trusted       INTEGER NOT NULL DEFAULT 0,
  -- 'file' given by a person or an agent; 'export' a site's own data export;
  -- 'site' text read from the owner's profile page on a site, never a file.
  kind          TEXT NOT NULL DEFAULT 'file',
  -- Lines that read as orders to a reader, kept from every reader of its facts.
  ignored_lines INTEGER
);
CREATE TABLE IF NOT EXISTS chunks (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id);

-- Inverted index for lexical retrieval. See retrieval.ts for why lexical
-- rather than a vector index.
CREATE TABLE IF NOT EXISTS postings (
  term          TEXT NOT NULL,
  chunk_id      TEXT NOT NULL,
  tf            INTEGER NOT NULL,
  PRIMARY KEY (term, chunk_id)
);
CREATE INDEX IF NOT EXISTS postings_term ON postings(term);
`;
