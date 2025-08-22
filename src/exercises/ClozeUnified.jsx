/**
 * Unified Cloze Exercise Generation
 * 
 * This module provides a unified approach to generating both regular Cloze and Cloze-Mixed exercises.
 * The core idea is to generate a comprehensive cloze analysis with all possible blanks, distractors,
 * and explanations, then let the UI components decide how to present them (text input vs dropdowns).
 */

import { pickRandomTopicSuggestion, formatTopicSuggestionForPrompt } from './utils.js';

/**
 * Schema for unified cloze generation using segments approach
 */
export const UNIFIED_CLOZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 80 },
          student_instructions: { type: 'string' },
          base_text_id: { type: ['string', 'null'] },
          chapter_number: { type: ['number', 'null'] },
          segments: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: ['text', 'blank'] },
                // Text segment properties
                content: { type: ['string', 'null'] },
                // Blank segment properties
                solution: { type: ['string', 'null'] },
                hint: { type: ['string', 'null'] },
                distractors: {
                  type: ['array', 'null'],
                  minItems: 3,
                  maxItems: 4,
                  items: { type: 'string' }
                },
                explanation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    solution: { type: 'string' },
                    distractor_explanations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          distractor: { type: 'string' },
                          explanation: { type: 'string' }
                        },
                        required: ['distractor', 'explanation']
                      }
                    }
                  }
                },
                difficulty_level: {
                  type: ['string', 'null'],
                  enum: ['easy', 'medium', 'hard'],
                  description: 'Relative difficulty of this blank within the exercise'
                },
                grammar_focus: {
                  type: ['string', 'null'],
                  description: 'The specific grammar point this blank tests (e.g., ser vs estar, preterite vs imperfect)'
                }
              },
              required: ['type']
            }
          },
          difficulty: { type: 'string' },
          total_blanks: { type: 'number' },
          suggested_blanks_easy: { type: 'number' },
          suggested_blanks_medium: { type: 'number' },
          suggested_blanks_hard: { type: 'number' }
        },
        required: ['title', 'student_instructions', 'segments', 'total_blanks', 'suggested_blanks_easy', 'suggested_blanks_medium', 'suggested_blanks_hard']
      }
    }
  },
  required: ['items']
};

/**
 * Generate unified cloze exercises from base text chapters
 */
export async function generateUnifiedCloze(topic, count = 1, languageContext) {
  const languageName = languageContext.language;
  const level = languageContext.level;
  const challengeMode = languageContext.challengeMode;
  const chapter = languageContext.chapter;
  const baseText = languageContext.baseText;

  if (!chapter || !chapter.passage) {
    throw new Error('No base text chapter provided for unified cloze generation');
  }

  const system = `You are a sophisticated language learning exercise creator. Given a text passage and a grammar topic, create a comprehensive cloze exercise that maximizes learning opportunities while maintaining narrative coherence.

Your task:
1. Create a grammatically correct and narratively coherent passage that maintains the story essence
2. Adapt the text strategically to include multiple instances of the target grammar topic
3. Create alternating segments of text and strategic blanks
4. For each blank, provide the solution, helpful hints, plausible distractors, and detailed explanations
5. Ensure the resulting passage flows naturally and makes sense as a complete story
6. Prioritize pedagogical value over exact text preservation

Target CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}`;

  const user = `Create a comprehensive cloze exercise based on this passage from "${baseText?.title || 'Unknown'}":

**Chapter: ${chapter.title}**
**Target Grammar:** ${topic}

**Original Passage:**
${chapter.passage}

**CRITICAL: You must create SEPARATE segments for text and blanks. Do NOT put underscores or blanks in text segments.**

**Segment Format Requirements:**
1. **Text segments**: contain only regular text with NO blanks or underscores
2. **Blank segments**: separate objects with solution, hint, distractors, etc.
3. **Alternating structure**: text → blank → text → blank → text (etc.)

**Example of CORRECT segment structure:**
For sentence "María vive en Madrid"
- Segment 1: {"type": "text", "content": "María "}
- Segment 2: {"type": "blank", "solution": "vive", "hint": "lives", "distractors": ["vivía", "vivirá", "vivió"], ...}  
- Segment 3: {"type": "text", "content": " en Madrid"}

**WRONG - DO NOT DO THIS:**
- {"type": "text", "content": "María _____ en Madrid"}

**Requirements:**
1. Adapt the passage to include multiple "${topic}" opportunities
2. Create 6-8 strategic blank segments (not text with underscores!)
3. Each blank segment must have: solution, hint, distractors (3-4), explanation, difficulty_level, grammar_focus
4. Text segments contain only plain text without any blanks
5. Maintain story coherence and narrative flow

Create alternating text and blank segments that reconstruct the adapted passage when combined.

Notice that the original passage does not contain the grammar topic, therefore rewrite it to include it.

**Example rewritten passage:**
"Hoy compro los boletos en línea."


**Example segment structure:**
Text: "Hoy" → Blank: solution="compro" → Text: "los boletos en línea."

The totality of the alternating text and blank segments should reconstruct the original passage or its rewritten version in its entirety.

Return comprehensive analysis with all segments and metadata.`;

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system,
      user,
      jsonSchema: UNIFIED_CLOZE_SCHEMA,
      schemaName: 'unified_cloze',
      metadata: { 
        language: languageName, 
        level, 
        challengeMode, 
        topic,
        baseTextId: baseText?.id,
        chapterNumber: chapter?.number,
        chapterTitle: chapter?.title
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to generate unified cloze: ${response.status}`);
  }

  const result = await response.json();
  
  // Add base text metadata to the result
  if (result.items && result.items[0]) {
    result.items[0].base_text_id = baseText?.id;
    result.items[0].chapter_number = chapter?.number;
  }

  return result;
}

/**
 * Convert unified cloze format to traditional Cloze format (text input)
 */
export function convertToTraditionalCloze(unifiedItem) {
  const segments = unifiedItem.segments || [];
  let passage = '';
  const blanks = [];
  let blankIndex = 0;

  segments.forEach(segment => {
    if (segment.type === 'text') {
      passage += segment.content;
    } else if (segment.type === 'blank') {
      passage += '_____'; // Traditional 5-underscore format
      
      // Convert distractor_explanations array to object format for compatibility
      const distractorExplanations = {};
      if (segment.explanation.distractor_explanations) {
        segment.explanation.distractor_explanations.forEach(item => {
          distractorExplanations[item.distractor] = item.explanation;
        });
      }

      blanks.push({
        index: blankIndex,
        answer: segment.solution,
        hint: segment.hint,
        rationale: segment.explanation.solution,
        difficulty_level: segment.difficulty_level,
        grammar_focus: segment.grammar_focus,
        distractor_explanations: distractorExplanations
      });
      
      blankIndex++;
    }
  });

  return {
    title: unifiedItem.title,
    studentInstructions: unifiedItem.student_instructions,
    passage,
    blanks,
    difficulty: unifiedItem.difficulty,
    base_text_id: unifiedItem.base_text_id,
    chapter_number: unifiedItem.chapter_number,
    exerciseSha: unifiedItem.exerciseSha,
    total_blanks_available: unifiedItem.total_blanks,
    metadata: {
      suggested_blanks_easy: unifiedItem.suggested_blanks_easy,
      suggested_blanks_medium: unifiedItem.suggested_blanks_medium,
      suggested_blanks_hard: unifiedItem.suggested_blanks_hard
    }
  };
}

/**
 * Convert unified cloze format to ClozeMixed format (dropdowns)
 */
export function convertToClozeMixed(unifiedItem) {
  const segments = unifiedItem.segments || [];
  let passage = '';
  const blanks = [];
  let blankIndex = 0;

  segments.forEach(segment => {
    if (segment.type === 'text') {
      passage += segment.content;
    } else if (segment.type === 'blank') {
      passage += '_____'; // Traditional 5-underscore format
      
      // Create options array with solution and distractors
      const options = [segment.solution, ...segment.distractors];
      // Shuffle the options to randomize correct answer position
      const shuffledOptions = shuffleArray(options);
      const correctIndex = shuffledOptions.indexOf(segment.solution);
      
      // Convert distractor_explanations array to object format for compatibility
      const distractorExplanations = {};
      if (segment.explanation.distractor_explanations) {
        segment.explanation.distractor_explanations.forEach(item => {
          distractorExplanations[item.distractor] = item.explanation;
        });
      }

      blanks.push({
        index: blankIndex,
        options: shuffledOptions,
        correct_index: correctIndex,
        hint: segment.hint,
        rationale: segment.explanation.solution,
        difficulty_level: segment.difficulty_level,
        grammar_focus: segment.grammar_focus,
        distractor_explanations: distractorExplanations
      });
      
      blankIndex++;
    }
  });

  return {
    title: unifiedItem.title,
    studentInstructions: unifiedItem.student_instructions,
    passage,
    blanks,
    difficulty: unifiedItem.difficulty,
    base_text_id: unifiedItem.base_text_id,
    chapter_number: unifiedItem.chapter_number,
    exerciseSha: unifiedItem.exerciseSha,
    total_blanks_available: unifiedItem.total_blanks,
    metadata: {
      suggested_blanks_easy: unifiedItem.suggested_blanks_easy,
      suggested_blanks_medium: unifiedItem.suggested_blanks_medium,
      suggested_blanks_hard: unifiedItem.suggested_blanks_hard
    }
  };
}

/**
 * Filter blanks by difficulty level for adaptive exercises
 */
export function filterBlanksByDifficulty(unifiedItem, targetDifficulties = ['easy', 'medium'], maxBlanks = 8) {
  const segments = unifiedItem.segments || [];
  const filteredSegments = [];
  let blankCount = 0;

  segments.forEach(segment => {
    if (segment.type === 'text') {
      filteredSegments.push(segment);
    } else if (segment.type === 'blank') {
      if (targetDifficulties.includes(segment.difficulty_level) && blankCount < maxBlanks) {
        filteredSegments.push(segment);
        blankCount++;
      } else {
        // Convert blank back to text with the solution
        filteredSegments.push({
          type: 'text',
          content: segment.solution
        });
      }
    }
  });

  return {
    ...unifiedItem,
    segments: filteredSegments,
    filtered_blank_count: blankCount,
    original_blank_count: unifiedItem.total_blanks
  };
}

/**
 * Utility function to shuffle array (Fisher-Yates algorithm)
 */
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Validate that unified cloze segments reconstruct the original passage
 */
export function validateSegmentReconstruction(segments, originalPassage) {
  let reconstructed = '';
  
  segments.forEach(segment => {
    if (segment.type === 'text') {
      reconstructed += segment.content;
    } else if (segment.type === 'blank') {
      reconstructed += segment.solution;
    }
  });
  
  return {
    isValid: reconstructed === originalPassage,
    original: originalPassage,
    reconstructed: reconstructed,
    originalLength: originalPassage.length,
    reconstructedLength: reconstructed.length
  };
}