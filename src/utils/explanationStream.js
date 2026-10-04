// Parse complete SSE events across arbitrary network chunk boundaries.
export async function readExplanationStream(response, onUpdate = () => {}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Streaming is unavailable. Please try again.');
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;
  const processEvent = (event) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); }
    catch { throw new Error('The lesson response was incomplete. Please try again.'); }
    if (payload.type === 'error') throw new Error(payload.error || 'Could not generate the explanation. Please try again.');
    onUpdate(payload);
    if (payload.type === 'final' && payload.explanation) final = payload.explanation;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        processEvent(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
      if (done) break;
    }
    if (buffer.trim()) processEvent(buffer);
    if (!final?.title || !final?.content_markdown) {
      throw new Error('The explanation did not finish. Please try again.');
    }
    return final;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
