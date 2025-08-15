// Utility helpers for exercises

/**
 * Normalize text for comparison.
 * - Lowercases
 * - Optionally removes accents/diacritics
 * - Trims
 * @param {string} text
 * @param {boolean} strictAccents When false, accents are ignored (á = a)
 */
export function normalizeText(text, strictAccents = true) {
  const input = String(text || '');
  if (!strictAccents) {
    return input
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }
  return input.toLowerCase().trim();
}

/**
 * Splits a sentence/passage by blanks represented by exactly five underscores (_____)
 * and returns an array of string segments between blanks.
 * @param {string} text
 * @returns {string[]}
 */
export function splitByBlanks(text) {
  return String(text || '').split(/_____+/);
}

/**
 * Count number of blanks (five underscores) in a sentence/passage.
 * @param {string} text
 * @returns {number}
 */
export function countBlanks(text) {
  const matches = String(text || '').match(/_____+/g);
  return matches ? matches.length : 0;
}

/**
 * Attempts to recover malformed blanks by converting various underscore patterns to standard blanks
 * @param {string} text - The text with potentially malformed blanks
 * @returns {string} - Text with recovered blanks
 */
export function recoverBlanks(text) {
  if (!text) return text;
  
  // First, try to find any underscore patterns and convert them to standard blanks
  // Look for patterns like: _, __, ___, ____, _____, ______, etc.
  let recovered = text.replace(/_+/g, '_____');
  
  // Also handle cases where there might be spaces or other characters mixed in
  recovered = recovered.replace(/[_ ]{3,}/g, '_____');
  
  return recovered;
}

/**
 * Validates that the number of blanks in text matches the expected count from blanks array
 * @param {string} text - The passage text
 * @param {Array} blanks - Array of blank objects
 * @returns {Object} - { isValid: boolean, expectedCount: number, actualCount: number, recoveredText?: string }
 */
export function validateClozePassage(text, blanks) {
  if (!text || !Array.isArray(blanks)) {
    return { isValid: false, expectedCount: 0, actualCount: 0 };
  }
  
  const expectedCount = blanks.length;
  const actualCount = countBlanks(text);
  
  if (expectedCount === actualCount) {
    return { isValid: true, expectedCount, actualCount };
  }
  
  // Try to recover the text
  const recoveredText = recoverBlanks(text);
  const recoveredCount = countBlanks(recoveredText);
  
  return {
    isValid: recoveredCount === expectedCount,
    expectedCount,
    actualCount,
    recoveredCount,
    recoveredText: recoveredCount === expectedCount ? recoveredText : undefined
  };
}

/**
 * Sanitizes a cloze passage by ensuring proper blank formatting and validation
 * @param {Object} item - The cloze item with passage and blanks
 * @returns {Object} - { sanitized: boolean, item: Object, warnings: Array<string> }
 */
export function sanitizeClozeItem(item) {
  if (!item || !item.passage || !Array.isArray(item.blanks)) {
    return { sanitized: false, item, warnings: ['Invalid item structure'] };
  }
  
  const warnings = [];
  let sanitizedItem = { ...item };
  
  // Validate blank count
  const validation = validateClozePassage(item.passage, item.blanks);
  
  if (!validation.isValid) {
    warnings.push(`Blank count mismatch: expected ${validation.expectedCount}, found ${validation.actualCount}`);
    
    // Try to recover if possible
    if (validation.recoveredText) {
      sanitizedItem.passage = validation.recoveredText;
      warnings.push('Passage recovered by fixing malformed blanks');
    } else {
      warnings.push('Could not recover passage - blank count mismatch remains');
    }
  }
  
  // Determine if this is a ClozeMixed exercise (has options) or regular Cloze (has answer)
  const isClozeMixed = item.blanks.length > 0 && item.blanks[0].hasOwnProperty('options');
  
  // Define required fields based on exercise type
  const requiredFields = isClozeMixed 
    ? ['index', 'options', 'correct_index', 'hint', 'rationale']
    : ['index', 'answer', 'hint', 'rationale'];
  
  item.blanks.forEach((blank, idx) => {
    requiredFields.forEach(field => {
      // Fix: properly check for undefined/null/empty string, but allow 0 as valid index
      if (blank[field] === undefined || blank[field] === null || blank[field] === '') {
        warnings.push(`Blank ${idx} missing ${field}`);
        if (!sanitizedItem.blanks[idx]) sanitizedItem.blanks[idx] = {};
        
        // Provide appropriate default values based on field type
        if (field === 'index') {
          sanitizedItem.blanks[idx][field] = idx;
        } else if (field === 'options' && isClozeMixed) {
          sanitizedItem.blanks[idx][field] = ['Missing option 1', 'Missing option 2', 'Missing option 3', 'Missing option 4'];
        } else if (field === 'correct_index' && isClozeMixed) {
          sanitizedItem.blanks[idx][field] = 0;
        } else {
          sanitizedItem.blanks[idx][field] = `Missing ${field}`;
        }
      }
    });
    
    // Additional validation for ClozeMixed exercises
    if (isClozeMixed) {
      // Ensure options array has exactly 4 items
      if (blank.options && Array.isArray(blank.options)) {
        if (blank.options.length !== 4) {
          warnings.push(`Blank ${idx} must have exactly 4 options, found ${blank.options.length}`);
          // Pad or truncate to exactly 4 options
          while (blank.options.length < 4) {
            blank.options.push(`Option ${blank.options.length + 1}`);
          }
          if (blank.options.length > 4) {
            blank.options = blank.options.slice(0, 4);
          }
        }
      }
      
      // Ensure correct_index is valid
      if (typeof blank.correct_index === 'number' && (blank.correct_index < 0 || blank.correct_index >= 4)) {
        warnings.push(`Blank ${idx} has invalid correct_index: ${blank.correct_index}, must be 0-3`);
        sanitizedItem.blanks[idx].correct_index = 0;
      }
    }
  });
  
  // Ensure blank indices are sequential and match their position
  sanitizedItem.blanks = sanitizedItem.blanks.map((blank, idx) => ({
    ...blank,
    index: idx
  }));
  
  return {
    sanitized: warnings.length === 0 || validation.recoveredText,
    item: sanitizedItem,
    warnings
  };
}


