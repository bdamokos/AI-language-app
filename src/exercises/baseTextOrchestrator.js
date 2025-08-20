/**
 * Base Text Orchestration
 * 
 * Manages chapter allocation across different exercise types to create synergies
 * while avoiding conflicts and spoilers.
 */

/**
 * Exercise type categorization for chapter allocation
 */
export const EXERCISE_CATEGORIES = {
  // Sequential: Consume chapters 1, 2, 3 in order, share same base text
  SEQUENTIAL: ['reading', 'cloze', 'cloze_mixed'],
  
  // Isolated: Need separate chapters from sequential, can share base text
  ISOLATED: ['mcq', 'fib', 'error_bundles'],
  
  // Independent: Don't use base texts (generate own content)
  INDEPENDENT: ['guided_dialogues', 'writing_prompts', 'explanation']
};

/**
 * Chapter allocation state tracker
 */
export class BaseTextChapterTracker {
  constructor() {
    this.allocations = {}; // { baseTextId: { chapterIndex: exerciseType } }
    this.baseTexts = {}; // { baseTextId: baseTextObject }
    this.sequentialCounter = 0; // Track sequential exercise generation order
  }

  /**
   * Add a base text to the tracker
   */
  addBaseText(baseText) {
    if (baseText?.id) {
      this.baseTexts[baseText.id] = baseText;
      if (!this.allocations[baseText.id]) {
        this.allocations[baseText.id] = {};
      }
    }
  }

  /**
   * Get next available chapter for sequential exercises (reading, cloze, cloze_mixed)
   * @param {string} baseTextId - Base text ID
   * @param {string} exerciseType - Type of exercise
   * @returns {Object|null} - { chapterIndex: number, chapter: object } or null
   */
  allocateSequentialChapter(baseTextId, exerciseType) {
    const baseText = this.baseTexts[baseTextId];
    if (!baseText || !Array.isArray(baseText.chapters)) return null;

    const allocations = this.allocations[baseTextId];
    const maxChapters = baseText.chapters.length;

    // Find next available chapter (0, 1, 2...)
    for (let i = 0; i < maxChapters; i++) {
      if (!allocations[i]) {
        allocations[i] = exerciseType;
        return {
          chapterIndex: i,
          chapter: baseText.chapters[i],
          baseTextId,
          allocationInfo: {
            type: 'sequential',
            exerciseType,
            chapterNumber: i + 1
          }
        };
      }
    }
    
    return null; // All chapters taken
  }

  /**
   * Get available chapter for isolated exercises (mcq, fib, error)
   * @param {string} baseTextId - Base text ID  
   * @param {string} exerciseType - Type of exercise
   * @returns {Object|null} - { chapterIndex: number, chapter: object } or null
   */
  allocateIsolatedChapter(baseTextId, exerciseType) {
    const baseText = this.baseTexts[baseTextId];
    if (!baseText || !Array.isArray(baseText.chapters)) return null;

    const allocations = this.allocations[baseTextId];
    const maxChapters = baseText.chapters.length;

    // Find any available chapter not used by sequential exercises
    for (let i = 0; i < maxChapters; i++) {
      const currentAllocation = allocations[i];
      if (!currentAllocation || !EXERCISE_CATEGORIES.SEQUENTIAL.includes(currentAllocation)) {
        // Chapter is free or only used by other isolated exercises
        allocations[i] = exerciseType;
        return {
          chapterIndex: i,
          chapter: baseText.chapters[i],
          baseTextId,
          allocationInfo: {
            type: 'isolated',
            exerciseType,
            chapterNumber: i + 1,
            sharedWith: currentAllocation ? [currentAllocation, exerciseType] : [exerciseType]
          }
        };
      }
    }

    return null; // No available chapters
  }

  /**
   * Get exclusion list for base text selection
   * @param {string} category - 'sequential' or 'isolated'
   * @returns {string[]} - Array of base text IDs to exclude
   */
  getBaseTextExclusions(category) {
    const exclusions = [];
    
    for (const [baseTextId, allocations] of Object.entries(this.allocations)) {
      const baseText = this.baseTexts[baseTextId];
      if (!baseText) continue;
      
      const maxChapters = baseText.chapters?.length || 0;
      const usedChapters = Object.keys(allocations).length;
      
      if (category === 'sequential') {
        // Exclude base texts where sequential exercises have used chapters
        const hasSequentialAllocations = Object.values(allocations)
          .some(exerciseType => EXERCISE_CATEGORIES.SEQUENTIAL.includes(exerciseType));
        if (hasSequentialAllocations && usedChapters >= maxChapters) {
          exclusions.push(baseTextId);
        }
      } else if (category === 'isolated') {
        // Exclude base texts with no available chapters
        if (usedChapters >= maxChapters) {
          exclusions.push(baseTextId);
        }
      }
    }
    
    return exclusions;
  }

  /**
   * Get debug info about current allocations
   */
  getDebugInfo() {
    return {
      allocations: this.allocations,
      baseTexts: Object.keys(this.baseTexts),
      summary: Object.entries(this.allocations).map(([baseTextId, allocations]) => ({
        baseTextId,
        title: this.baseTexts[baseTextId]?.title || 'Unknown',
        allocations
      }))
    };
  }
}

/**
 * Create chapter allocation context for exercises
 * @param {Object} baseText - Base text object
 * @param {number} chapterIndex - Chapter index (0-based)
 * @param {Object} allocationInfo - Allocation metadata
 * @returns {Object} - Context for exercise generation
 */
export function createChapterContext(baseText, chapterIndex, allocationInfo) {
  const chapter = baseText.chapters?.[chapterIndex];
  if (!chapter) return null;

  return {
    baseText: {
      id: baseText.id,
      title: baseText.title,
      synopsis: baseText.synopsis,
      genre: baseText.genre,
      source: baseText.source
    },
    chapter: {
      index: chapterIndex,
      number: chapterIndex + 1,
      title: chapter.title,
      passage: chapter.passage,
      suitability: chapter.suitability,
      key_grammar_concepts: chapter.key_grammar_concepts
    },
    allocation: allocationInfo,
    context: {
      // Provide context from other chapters for coherence
      previousChapters: chapterIndex > 0 ? baseText.chapters.slice(0, chapterIndex) : [],
      nextChapters: chapterIndex < baseText.chapters.length - 1 ? baseText.chapters.slice(chapterIndex + 1) : []
    }
  };
}