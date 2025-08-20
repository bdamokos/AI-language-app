/**
 * Base text generation prompts and schemas for creating narrative texts
 * that serve as source material for various exercise types.
 */

/**
 * System prompt for base text generation
 */
export const BASE_TEXT_SYSTEM_PROMPT = `You generate rich narrative base texts used to derive multiple exercise types. The base text should be structured, cohesive, and divided into three chapters that progressively build context.`;

/**
 * Generate user prompt for base text creation
 * @param {string} topic - The topic for the base text
 * @param {string} language - Target language (e.g., 'es', 'en')  
 * @param {string} level - CEFR level (e.g., 'B1')
 * @param {boolean} challengeMode - Whether to make content slightly challenging
 * @param {string} focus - Optional specialized focus for the narrative
 * @returns {string} The formatted user prompt
 */
export function generateBaseTextUserPrompt(topic, language, level, challengeMode, focus = null) {
  const focusLine = focus && String(focus).trim() 
    ? `Specialized focus: ${String(focus).trim()}. Ensure the narrative naturally emphasizes this focus.` 
    : '';
    
  return `Create a structured base text in ${language} about: ${topic}.

Requirements:
- Audience CEFR level: ${level}${challengeMode ? ' (slightly challenging)' : ''}
- Use a natural mix of grammar structures appropriate for ${level} level across all chapters
- Provide JSON with the required fields (see schema)
- Chapters should be of increasing complexity and each 120-250 words for B1; scale by level
- For each chapter's suitability field, return ALL CEFR levels where the text is suitable (understandable yet challenging)
- Use ONLY these exact CEFR codes: A1, A2, B1, B2, C1, C2 (no descriptive text)
- Example: A B1 chapter might be suitable for ["A2", "B1", "B2"] learners - include all applicable levels
- Assess which CEFR levels each chapter is suitable for and identify key grammar concepts used
- Ensure cultural appropriateness
${focusLine}`;
}

/**
 * JSON schema for base text structure with suitability assessment
 */
export const BASE_TEXT_SCHEMA = {
  type: 'object', 
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    synopsis: { type: 'string' },
    genre: { type: 'string' },
    key_entities: { type: 'array', items: { type: 'string' } },
    key_vocabulary: { type: 'array', items: { type: 'string' } },
    chapters: {
      type: 'array', 
      minItems: 3, 
      maxItems: 3, 
      items: {
        type: 'object', 
        additionalProperties: false,
        properties: { 
          title: { type: 'string' }, 
          passage: { type: 'string' },
          suitability: { 
            type: 'array',
            items: { 
              type: 'string',
              enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
            },
            minItems: 1,
            description: 'ALL CEFR levels where this passage is suitable (understandable yet challenging). Include multiple levels. Example: ["A2", "B1", "B2"]'
          },
          key_grammar_concepts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Main grammar structures used in this passage'
          }
        },
        required: ['title', 'passage', 'suitability', 'key_grammar_concepts']
      }
    }
  },
  required: ['title', 'synopsis', 'chapters']
};

/**
 * Add source metadata to base text content
 * @param {Object} content - The base text content from AI
 * @param {string} model - The model used for generation
 * @returns {Object} Content with source metadata added
 */
export function addSourceMetadata(content, model) {
  return {
    ...content,
    source: {
      type: 'ai_generated',
      model: model,
      generated_at: new Date().toISOString()
    }
  };
}

/**
 * Calculate overall text suitability from chapter suitabilities
 * @param {Array} chapters - Array of chapter objects with suitability arrays
 * @returns {Object} - { primary: string[], secondary: string[] }
 */
export function calculateTextSuitability(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return { primary: [], secondary: [] };
  }

  // Collect all suitability levels from all chapters
  const allLevels = new Set();
  const levelCounts = {};
  
  chapters.forEach(chapter => {
    if (Array.isArray(chapter.suitability)) {
      chapter.suitability.forEach(level => {
        const normalizedLevel = String(level).toUpperCase();
        allLevels.add(normalizedLevel);
        levelCounts[normalizedLevel] = (levelCounts[normalizedLevel] || 0) + 1;
      });
    }
  });

  const totalChapters = chapters.length;
  const primary = []; // Levels suitable for all/most chapters
  const secondary = []; // Levels suitable for some chapters (fallback)

  // Primary suitability: levels that appear in at least 2/3 of chapters
  // Secondary suitability: levels that appear in at least 1/3 of chapters
  for (const level of allLevels) {
    const count = levelCounts[level];
    const ratio = count / totalChapters;
    
    if (ratio >= 0.67) { // 2/3 or more chapters
      primary.push(level);
    } else if (ratio >= 0.33) { // 1/3 or more chapters
      secondary.push(level);
    }
  }

  // Sort levels by standard CEFR order
  const cefrOrder = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const sortByCefr = (levels) => levels.sort((a, b) => {
    const aIndex = cefrOrder.indexOf(a);
    const bIndex = cefrOrder.indexOf(b);
    return aIndex - bIndex;
  });

  return {
    primary: sortByCefr(primary),
    secondary: sortByCefr(secondary)
  };
}

/**
 * Check if a base text is suitable for a given user level and challenge mode
 * @param {Object} baseText - The base text with suitability info
 * @param {string} userLevel - User's CEFR level
 * @param {boolean} challengeMode - Whether user is in challenge mode
 * @returns {Object} - { suitable: boolean, reason: string, priority: number }
 */
export function checkTextSuitability(baseText, userLevel, challengeMode = false) {
  if (!baseText || !baseText.chapters) {
    return { suitable: false, reason: 'Invalid base text', priority: 0 };
  }

  const suitability = calculateTextSuitability(baseText.chapters);
  const { primary, secondary } = suitability;
  
  const cefrOrder = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const userLevelIndex = cefrOrder.indexOf(userLevel.toUpperCase());
  
  if (userLevelIndex === -1) {
    return { suitable: false, reason: 'Invalid user level', priority: 0 };
  }

  // Check primary suitability (high priority)
  if (primary.includes(userLevel.toUpperCase())) {
    return { suitable: true, reason: 'Perfect match', priority: 3 };
  }

  // Challenge mode users can access one level above
  if (challengeMode && userLevelIndex < cefrOrder.length - 1) {
    const oneLevelAbove = cefrOrder[userLevelIndex + 1];
    if (primary.includes(oneLevelAbove)) {
      return { suitable: true, reason: 'Challenge mode - one level above', priority: 2 };
    }
  }

  // Users can access texts at their level or below (from primary)
  for (let i = userLevelIndex; i >= 0; i--) {
    if (primary.includes(cefrOrder[i])) {
      return { suitable: true, reason: 'Suitable level below', priority: 2 };
    }
  }

  // Fallback to secondary suitability (lower priority)
  if (secondary.includes(userLevel.toUpperCase())) {
    return { suitable: true, reason: 'Partial match', priority: 1 };
  }

  // Challenge mode fallback
  if (challengeMode && userLevelIndex < cefrOrder.length - 1) {
    const oneLevelAbove = cefrOrder[userLevelIndex + 1];
    if (secondary.includes(oneLevelAbove)) {
      return { suitable: true, reason: 'Challenge mode fallback', priority: 1 };
    }
  }

  // Secondary level below
  for (let i = userLevelIndex; i >= 0; i--) {
    if (secondary.includes(cefrOrder[i])) {
      return { suitable: true, reason: 'Fallback level below', priority: 1 };
    }
  }

  return { suitable: false, reason: 'No suitable level found', priority: 0 };
}