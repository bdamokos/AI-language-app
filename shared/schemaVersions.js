export const schemaVersions = {
  explanation: 1,
  base_text: 3,
  fib: 2,
  mcq: 2,
  cloze: 99, // Bumping version to force cache ejection before deprecation (merged under unified_cloze)
  cloze_mixed: 99, // Bumping version to force cache ejection before deprecation (merged under unified_cloze)
  unified_cloze: 2, // Unified cloze format for shared caching between traditional and mixed - updated distractor explanations structure
  writing_prompts: 1,
  guided_dialogues: 2,
  reading: 3,
  error_bundle: 2,
  rewriting: 1,
  // UI/tutorial versioning for onboarding tour
  onboarding: 1
};


