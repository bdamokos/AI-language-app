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


