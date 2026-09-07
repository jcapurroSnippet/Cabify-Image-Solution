/**
 * Runs `mapper` over `values` with at most `limit` calls in flight at once,
 * storing each result at its original index so the returned array preserves
 * input order regardless of completion order.
 *
 * If `mapper` throws, no further work is started and the error is rethrown
 * once every in-flight call has settled. A caller that wants partial results
 * back (skip the failures, keep the successes) must catch inside its own
 * mapper and return a sentinel instead of letting the rejection propagate.
 */
export const mapWithBoundedConcurrency = async (values, limit, mapper) => {
  const results = new Array(values.length);
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(values.length, Math.max(1, limit));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index);
      } catch (error) {
        firstError ||= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
};
