/**
 * Runs `task` over `items` with at most `limit` invocations in flight at
 * once, batching items into chunks of `limit` and settling each chunk with
 * `Promise.allSettled` before starting the next. A failure in one item never
 * aborts the others — every item gets a fulfilled/rejected result, in the
 * same order as the input.
 */
export async function withConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  const chunkSize = Math.max(1, limit);

  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    const settled = await Promise.allSettled(chunk.map((item, i) => task(item, start + i)));
    results.push(...settled);
  }

  return results;
}
