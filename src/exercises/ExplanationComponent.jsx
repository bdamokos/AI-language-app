import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Explanation component for lessons
 * Props:
 * - explanation: { title: string, content_markdown: string }
 */
export default function ExplanationComponent({ explanation }) {
  if (!explanation) return null;

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
  
  const system = `You are a language pedagogy expert. Provide a concise, insightful explanation of a ${languageName} grammar concept with examples. Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}. Where relevant, add a section on common mistakes and how to avoid them. Additionally, where relevant, include a section on cultural context, regional differences, usage tips, etymology and other relevant information.`;

  const normalizeTopic = (input) => {
    if (typeof input === 'string') return input.trim();
    if (input && typeof input.topic === 'string') return input.topic.trim();
    if (input && typeof input.text === 'string') return input.text.trim();
    return '';
  };
  const safeTopic = normalizeTopic(topic);

  const user = `Explain the grammar concept: ${safeTopic}. 

Target Language: ${languageName}
Target Level: ${level}${challengeMode ? ' (slightly challenging)' : ''}

Keep it 200-600 words and ensure vocabulary and grammar complexity matches ${level} level${challengeMode ? ' with separate advanced explanations for more eager learners' : ''}.`;

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
      schemaName: 'explanation'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate explanation: ${response.status}`);
  }

  return response.json();
}