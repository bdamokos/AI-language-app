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
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <h2 className="text-xl font-semibold text-blue-900 mb-3">{explanation.title}</h2>
      <div className="prose prose-sm max-w-none text-blue-800">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {explanation.content_markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/**
 * Generate explanation using the generic LLM endpoint
 * @param {string} topic - The topic to explain
 * @param {string} language - Language for examples (default: 'es')
 * @returns {Promise<{title: string, content_markdown: string}>} Generated explanation
 */
export async function generateExplanation(topic, language = 'es') {
  const system = 'You are a language pedagogy expert. Provide a concise, insightful explanation of a Spanish grammar concept with examples and counterexamples.';
  
  const user = `Explain the grammar concept: ${topic}. Language for examples: ${language}. Keep it 200-400 words.`;

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
      maxTokens: 2500,
      jsonSchema: schema,
      schemaName: 'explanation'
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate explanation: ${response.status}`);
  }

  return response.json();
}