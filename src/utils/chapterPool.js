/** Serialize chapter-backed requests and consume source chapters only on success. */
export function createChapterPool(fetchBaseText) {
  let tail = Promise.resolve();
  let revision = 0;
  let controller = new AbortController();
  let currentKey, base, cursor = 0, usedIds = new Set();
  const reset = () => {
    controller.abort(); controller = new AbortController(); revision++;
    // An old provider may take time to observe cancellation. Its eventual
    // result is revision-checked, so the new lesson need not wait behind it.
    tail = Promise.resolve();
    currentKey = undefined; base = undefined; cursor = 0; usedIds = new Set();
  };
  return {
    reset,
    get signal() { return controller.signal; },
    run({ context, count, batchSize = 1, generate, onStage = () => {}, excludeIds = [] }) {
      if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(batchSize) || batchSize < 1) {
        return Promise.reject(new Error('Choose a whole number of exercises between 1 and 20.'));
      }
      const startedRevision = revision;
      const signal = controller.signal;
      const checkActive = () => { if (revision !== startedRevision) throw new Error('The lesson changed. Generate exercises for the new lesson.'); };
      onStage('Waiting for the current exercise…');
      const operation = tail.catch(() => {}).then(async () => {
        checkActive();
        const key = JSON.stringify(context);
        if (key !== currentKey) { currentKey = key; base = undefined; cursor = 0; usedIds = new Set(); }
        const items = [];
        try {
          while (items.length < count) {
            checkActive();
            if (!base || cursor >= base.chapters.length || excludeIds.includes(base.id)) {
              onStage('Preparing source text…');
              const next = await fetchBaseText({ ...context, signal, excludeIds: [...new Set([...usedIds, ...excludeIds])] });
              checkActive();
              if (!Array.isArray(next?.chapters) || !next.chapters.length || next.chapters.some(chapter => typeof chapter?.passage !== 'string' || !chapter.passage.trim())) {
                throw new Error('No usable source text was returned. Please try again.');
              }
              base = next; cursor = 0;
              if (base.id) usedIds.add(base.id);
            }
            onStage('Generating exercises…');
            const requested = Math.min(batchSize, count - items.length);
            const output = await generate(requested, { ...context, signal, baseText: base, chapter: { ...base.chapters[cursor], index: cursor, number: cursor + 1 } });
            checkActive();
            if (!Array.isArray(output?.items) || output.items.length !== requested) {
              throw new Error(`Expected ${requested} exercises but received ${output?.items?.length || 0}. Please try again.`);
            }
            cursor++;
            items.push(...output.items);
          }
        } catch (error) {
          // Successful batches already consumed their source and inference.
          // Keep them available to the UI when a later batch fails. A reset
          // must never carry old exercises into the replacement lesson.
          if (items.length && revision === startedRevision && !signal.aborted) {
            const failure = error instanceof Error ? error : new Error('Exercise generation failed.');
            failure.partialItems = items.slice();
            throw failure;
          }
          throw error;
        }
        return { items };
      });
      tail = operation;
      return operation;
    },
  };
}
