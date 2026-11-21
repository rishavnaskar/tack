/**
 * One tab receives input at a time, per browser.
 *
 * Input goes to whichever tab is in front, and an action brings its own tab
 * forward first. With several tabs being driven at once, two actions could
 * interleave: one brings its tab forward, the other does the same, and the
 * first then clicks into a tab that is no longer in front. So bringing a tab
 * forward and sending it input happen as one step, queued per browser.
 * Observing, navigating and waiting on a model are not queued, and that is
 * where the time goes.
 */
const tails = new WeakMap<object, Promise<unknown>>();

/** Hands the turn on while `wait` runs, then queues for it again; the caller brings its tab forward once it has it back. */
export type InputAside = <W>(wait: () => Promise<W>) => Promise<W>;

/**
 * `release` hands the turn on early, once the input is in and what is left is
 * waiting on the page (a typeahead's list, a read-back): other sessions should
 * not queue behind a debounce. `aside` does the same for a wait in the middle
 * of an action (a dropdown's options loading), and takes a turn again after it.
 */
export function exclusiveInput<T>(browser: object, work: (release: () => void, aside: InputAside) => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  /** Queue behind whoever holds the turn now; resolves once this caller has it. */
  const take = (): Promise<void> => {
    const previous = tails.get(browser) ?? Promise.resolve();
    tails.set(browser, new Promise<void>((resolve) => { release = resolve; }));
    return previous.then(() => {}, () => {});
  };
  const aside: InputAside = async (wait) => {
    release();
    let result: Awaited<ReturnType<typeof wait>>;
    try {
      result = await wait();
    } finally {
      await take();
    }
    return result;
  };
  return take().then(async () => {
    try {
      return await work(() => release(), aside);
    } finally {
      release();
    }
  });
}
