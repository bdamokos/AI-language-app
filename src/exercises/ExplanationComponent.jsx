import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Explanation component for lessons
 * Props:
 * - explanation: { title: string, content_markdown: string }
 */
export default function ExplanationComponent({ explanation }) {
  if (!explanation) return null;
  const [voted, setVoted] = useState(null);
  const cacheKey = explanation._cacheKey;

  const sendVote = async (like) => {
    if (!cacheKey || voted !== null) return;
    setVoted(like ? 'up' : 'down');
    try {
      await fetch('/api/rate/explanation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cacheKey, like })
      });
    } catch {}
  };

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 mb-4">
      <h2 className="text-xl font-semibold text-slate-900 mb-4">{explanation.title}</h2>
      <div className="prose prose-slate prose-sm max-w-none">
        <ReactMarkdown 
          remarkPlugins={[remarkGfm]}
          components={{
            // Override paragraph styling for better spacing
            p: ({children}) => <p className="mb-4 leading-relaxed text-slate-700">{children}</p>,
            // Style tables properly
            table: ({children}) => (
              <div className="overflow-x-auto my-4">
                <table className="min-w-full border-collapse border border-slate-300 bg-white rounded-lg shadow-sm">
                  {children}
                </table>
              </div>
            ),
            thead: ({children}) => <thead className="bg-slate-100">{children}</thead>,
            th: ({children}) => (
              <th className="border border-slate-300 px-4 py-3 text-left font-semibold text-slate-900 bg-slate-50">
                {children}
              </th>
            ),
            td: ({children}) => (
              <td className="border border-slate-300 px-4 py-3 text-slate-700">
                {children}
              </td>
            ),
            // Style headings
            h3: ({children}) => <h3 className="text-lg font-semibold text-slate-900 mt-6 mb-3">{children}</h3>,
            h4: ({children}) => <h4 className="text-base font-semibold text-slate-800 mt-4 mb-2">{children}</h4>,
            // Style lists
            ul: ({children}) => <ul className="mb-4 pl-6 list-disc text-slate-700">{children}</ul>,
            ol: ({children}) => <ol className="mb-4 pl-6 list-decimal text-slate-700">{children}</ol>,
            li: ({children}) => <li className="mb-1">{children}</li>,
            // Style strong text
            strong: ({children}) => <strong className="font-semibold text-slate-900">{children}</strong>,
            // Style code blocks
            code: ({children, className}) => {
              const isInline = !className;
              return isInline ? (
                <code className="bg-slate-200 px-1.5 py-0.5 rounded text-sm font-mono text-slate-800">
                  {children}
                </code>
              ) : (
                <code className={className}>{children}</code>
              );
            }
          }}
        >
          {explanation.content_markdown}
        </ReactMarkdown>
      </div>
      {cacheKey && (
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-600">
          <span>Was this helpful?</span>
          <button
            type="button"
            onClick={() => sendVote(true)}
            disabled={voted !== null}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${voted === 'up' ? 'bg-green-100 border-green-300 text-green-700' : 'border-slate-300 hover:bg-slate-100'}`}
            aria-label="Thumbs up"
          >
            <ThumbsUp size={14} /> Like
          </button>
          <button
            type="button"
            onClick={() => sendVote(false)}
            disabled={voted !== null}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${voted === 'down' ? 'bg-red-100 border-red-300 text-red-700' : 'border-slate-300 hover:bg-slate-100'}`}
            aria-label="Thumbs down"
          >
            <ThumbsDown size={14} /> Dislike
          </button>
          {voted && <span className="ml-1">Thanks for the feedback!</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Generate explanation using the generic LLM endpoint
 * @param {string} topic - The topic to explain
 * @param {Object} languageContext - Language and level context { language, level, challengeMode }
 * @returns {Promise<{title: string, content_markdown: string}>} Generated explanation
 */
export async function generateExplanation(topic, languageContext = { language: 'es', level: 'B1', challengeMode: false }) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  
  const system = `You are a language pedagogy expert. Provide a concise, insightful explanation of a grammar concept with examples.

Requirements:
- Write in the target language and match the target level
- Where relevant, add sections on common mistakes (and fixes), cultural context, regional differences, usage tips, and etymology
- Return clean markdown: start with a top-level heading (#) for the title, then the explanation
- Keep length roughly 200–600 words
- If necessary for clarity, include brief English translations in parentheses
- Return ONLY content; do not echo instructions`;

  const normalizeTopic = (input) => {
    if (typeof input === 'string') return input.trim();
    if (input && typeof input.topic === 'string') return input.topic.trim();
    if (input && typeof input.text === 'string') return input.text.trim();
    return '';
  };
  const safeTopic = normalizeTopic(topic);

  const user = `Task: Explain the grammar concept.
Concept: ${safeTopic}
Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}`;

  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Short title of the concept' },
      content_markdown: { type: 'string', description: 'Well-structured markdown with headings and examples' }
    },
    required: ['title', 'content_markdown']
  };

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: schema,
      schemaName: 'explanation',
      metadata: {
        language: languageName,
        level,
        challengeMode,
        topic: safeTopic
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate explanation: ${response.status}`);
  }

  return response.json();
}

/**
 * Stream explanation using SSE for quicker feedback
 * @param {string} topic
 * @param {{language:string, level:string, challengeMode:boolean}} languageContext
 * @param {(partial: { type: 'prefill'|'delta'|'final'|'error', explanation?: any, text?: string, title?: string, error?: string }) => void} onUpdate
 * @returns {Promise<{title:string, content_markdown:string, _cacheKey?:string}>}
 */
export async function generateExplanationStream(topic, languageContext = { language: 'es', level: 'B1', challengeMode: false }, onUpdate = () => {}) {
  const body = {
    topic: typeof topic === 'string' ? topic : (topic?.topic || topic?.text || ''),
    language: languageContext?.language || 'es',
    level: languageContext?.level || 'B1',
    challengeMode: !!languageContext?.challengeMode
  };
  const resp = await fetch('/api/explanations/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  // If server fell back to JSON (non-stream), just return it
  const ctype = resp.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    if (!resp.ok) throw new Error(`Failed to stream explanation: ${resp.status}`);
    const json = await resp.json().catch(() => null);
    if (json && json.title && json.content_markdown) return json;
    throw new Error('Unexpected response');
  }
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('Streaming not supported');
  const decoder = new TextDecoder();
  let buffer = '';
  let final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find(l => l.startsWith('data:')) || '';
      if (!line) continue;
      try {
        const payload = JSON.parse(line.slice(5).trim());
        onUpdate(payload);
        if (payload.type === 'final' && payload.explanation) {
          final = payload.explanation;
        }
      } catch {}
    }
  }
  if (!final) throw new Error('Stream ended without final explanation');
  return final;
}
