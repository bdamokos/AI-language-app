export function normalizeExerciseCount(count, maximum = 20) {
  const value = Number(count);
  return Math.max(1, Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : 1));
}

export const hasText = value => typeof value === 'string' && value.trim().length > 0;

export function validateGeneratedItems(result, count, label, isValid) {
  if (!Array.isArray(result?.items) || result.items.length !== count ||
      result.items.some(item => !item || !isValid(item))) {
    throw new Error(`ChatGPT returned incomplete ${label}. Please try again.`);
  }
  return result;
}
