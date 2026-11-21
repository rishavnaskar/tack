/**
 * Reading a TAP report well enough to say WHY something failed.
 *
 * The distinction this exists for: a browser that disappeared mid-test and an
 * assertion that failed look almost identical in a test summary, and mean
 * opposite things — one is an environment problem, the other is a defect.
 *
 * Counting occurrences of an error string across the whole output is not the
 * same as knowing why each test failed: it can report nine failures while
 * explaining eight, leaving one silently unaccounted for — and the failure
 * you cannot explain is exactly the one that might matter.
 */

/**
 * Why a test failed, as far as the report can tell.
 *
 *   assertion    - a check in this code did not hold. A defect.
 *   browser-lost - the browser or its transport went away underneath us.
 *   protocol     - CDP answered with an error. Usually a dying session, but
 *                  not proof of one, and not evidence of a defect either.
 *   precondition - the code was used in an order it does not support, e.g.
 *                  asking for the page before a browser exists. Worth
 *                  looking at; not the same as a failed assertion.
 *   unknown      - could not be attributed. Reported as such rather than
 *                  filed under whichever bucket happened to be the default.
 */
export type FailureCause = 'assertion' | 'browser-lost' | 'protocol' | 'precondition' | 'unknown';

export interface Failure {
  name: string;
  error: string;
  cause: FailureCause;
}

/** The transport or the browser went away. */
const BROWSER_LOST =
  /CDP client closed|browser is gone|Chrome exited|transport closed|connection closed|Target closed|WebSocket is not open|socket hang up|the tab this page was driving is gone|TAB_LOST/i;

/**
 * CDP answered with an error.
 *
 * "Session with given id not found" is the common one and usually means the
 * session died — but a protocol error is not proof of that, and it is
 * certainly not proof of a defect here. node:test labels any thrown error
 * `testCodeFailure`, so filing these under assertions would call environment
 * failures code defects.
 */
const PROTOCOL_ERROR =
  /Session with given id not found|Inspected target navigated or closed|No target with given id|failed \(-3\d{4}\)|CdpError|Protocol error/i;

/**
 * Used in an order the code does not support.
 *
 * Distinct from browser loss on purpose: "browser not started" means
 * something asked for the page before starting one, which is a wiring
 * question about the caller, not evidence that a browser died. Folding it
 * into browser loss would hide exactly that.
 */
const PRECONDITION =
  /browser not started|not connected|call startBrowser|no live observation|requires the pageStateId/i;

/**
 * What a failed assertion reads like.
 *
 * A fallback only. node:test labels assertion failures with an
 * `ERR_ASSERTION` code, which is definitive; this exists so the classifier
 * still works against a reporter that omits it. It is checked LAST, so it
 * cannot swallow a protocol or transport error whose message happens to be
 * quoted inside an assertion.
 */
const ASSERTION_TEXT =
  /Expected values to be|AssertionError|Expected .+ to (be|equal|match|contain)|The expression evaluated to a falsy value|Missing expected (rejection|exception)|strictEqual|deepStrictEqual|did not (throw|reject)/i;

/**
 * One entry per failing LEAF test.
 *
 * Rows that only report that something beneath them failed are skipped, so a
 * failure is counted once, where it happened, rather than again at every
 * level of nesting above it.
 */
export function parseFailures(output: string): Failure[] {
  const lines = output.split('\n');
  const failures: Failure[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*not ok \d+ - (.+)$/.exec(lines[i]);
    if (!header) continue;

    let error = '';
    let failureType = '';
    let code = '';
    let name = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*(not ok|ok) \d+ - /.test(lines[j])) break;

      // A block scalar introduces a multi-line message; take its first line.
      if (/^\s*error: \|-?\s*$/.test(lines[j])) {
        if (!error) error = (lines[j + 1] ?? '').trim();
        continue;
      }
      const inline = /^\s*error: '?(.*?)'?\s*$/.exec(lines[j]);
      if (inline && !error) error = inline[1];

      const type = /^\s*failureType: '(.+)'\s*$/.exec(lines[j]);
      if (type && !failureType) failureType = type[1];

      const codeLine = /^\s*code: '(.+)'\s*$/.exec(lines[j]);
      if (codeLine && !code) code = codeLine[1];

      const nameLine = /^\s*name: '(.+)'\s*$/.exec(lines[j]);
      if (nameLine && !name) name = nameLine[1];
    }

    if (failureType === 'subtestsFailed' || /^\d+ subtests? failed$/.test(error)) continue;

    failures.push({ name: header[1].trim(), error, cause: classify(error, code, name) });
  }
  return failures;
}

/**
 * `failureType` is not read here: `testCodeFailure` only means the test
 * function threw. It covers a failed assertion and a thrown protocol error
 * equally, so on its own it does not identify a defect and must not be read
 * as one.
 */
function classify(error: string, code: string, name: string): FailureCause {
  // The runner tells us outright when a check failed, and that beats reading
  // the message — an assertion whose text happens to mention the browser is
  // still an assertion.
  if (name === 'AssertionError' || code === 'ERR_ASSERTION') return 'assertion';

  // The same argument in the other direction: a test that deliberately typed
  // its failure as browser loss knows more than any message-matching can.
  // Read from the message alone, the browser tests' own BrowserLostError
  // comes back "unknown", which reads as "worth looking at directly" for
  // something the test already explained.
  if (name === 'BrowserLostError') return 'browser-lost';

  if (BROWSER_LOST.test(error)) return 'browser-lost';
  if (PROTOCOL_ERROR.test(error)) return 'protocol';
  if (PRECONDITION.test(error)) return 'precondition';

  // Last, so it cannot swallow an environment error quoted in a message.
  if (ASSERTION_TEXT.test(error)) return 'assertion';
  return 'unknown';
}

/** Totals from the TAP summary, which is authoritative about counts. */
export function parseTotals(output: string): { tests: number; passed: number; failed: number } {
  const read = (label: string): number =>
    Number(new RegExp('^# ' + label + ' (\\d+)', 'm').exec(output)?.[1] ?? 0);
  return { tests: read('tests'), passed: read('pass'), failed: read('fail') };
}
