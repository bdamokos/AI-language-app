/**
 * Topic Roulette: Curated topics for language learning content generation
 * Shared between server and client for consistent topic selection
 */

export const TOPIC_ROULETTE_CATEGORIES = [
  {
    category: 'Everyday & Practical',
    topics: [
      'Daily routines',
      'Shopping at the market or supermarket',
      'Cooking and recipes',
      'Eating out at a café or restaurant',
      'Transport and commuting',
      'At the doctor; health and wellbeing',
      'Household chores and family life'
    ]
  },
  {
    category: 'Leisure & Hobbies',
    topics: [
      'Sports and exercise',
      'Music and concerts',
      'Watching films, TV, or streaming',
      'Reading books or comics',
      'Weekend plans with friends',
      'Digital life with apps, social media, and gaming'
    ]
  },
  {
    category: 'Work & Study',
    topics: [
      'School life and exams',
      'Choosing a career or studies',
      'Office life and colleagues',
      'Remote work and technology',
      'Learning a new skill or language'
    ]
  },
  {
    category: 'Travel & Places',
    topics: [
      'Planning a trip',
      'At the airport or train station',
      'Visiting a city landmark',
      'Countryside or nature trips',
      'Travel mishaps and surprises',
      'Getting lost in a new city'
    ]
  },
  {
    category: 'Social & Relationships',
    topics: [
      'Meeting new people',
      'Family visits and celebrations',
      'Friendship conflicts and reconciliation',
      'Dating and romance (classroom-safe framing)',
      'Helping a neighbor and community life'
    ]
  },
  {
    category: 'Culture & Society',
    topics: [
      'Festivals and traditions',
      'Food culture and customs',
      'Local legends and folktales',
      'Historical figures and events',
      'Famous authors and literature',
      'Museums and art',
      'Media and news'
    ]
  },
  {
    category: 'Broader Issues',
    topics: [
      'Environment and climate',
      'Technology and AI',
      'Politics and government',
      'Education debates',
      'Social inequality',
      'Migration and identity',
      'Ethical dilemmas'
    ]
  },
  {
    category: 'Personal & Reflective',
    topics: [
      'Dreams and ambitions',
      'Childhood memories',
      'Comparing cultures',
      'Future plans',
      'Personal achievements'
    ]
  }
];

/**
 * Build a flattened topic pool from categories
 * @returns {{ category: string, topic: string, key: string }[]}
 */
function buildTopicPool() {
  const pool = [];
  for (const group of TOPIC_ROULETTE_CATEGORIES) {
    for (const t of group.topics) {
      pool.push({ category: group.category, topic: t, key: `${group.category} | ${t}` });
    }
  }
  return pool;
}

/**
 * Simple seeded RNG (Mulberry32) when a numeric seed is provided; otherwise Math.random.
 * @param {number|undefined} seed
 */
function createRandom(seed) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    return Math.random;
  }
  let a = seed >>> 0;
  return function seeded() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Pick a random topic suggestion from the curated pool.
 * @param {Object} [opts]
 * @param {string[]} [opts.includeCategories]
 * @param {string[]} [opts.excludeCategories]
 * @param {string[]} [opts.recentTopics] - List of topic strings to avoid repeating
 * @param {number} [opts.seed] - Optional numeric seed for deterministic selection
 * @param {string} [opts.ensureNotEqualTo] - Avoid this exact topic if possible
 * @returns {{ category: string, topic: string, key: string }}
 */
export function pickRandomTopicSuggestion(opts = {}) {
  const {
    includeCategories,
    excludeCategories,
    recentTopics = [],
    seed,
    ensureNotEqualTo
  } = opts;

  const random = createRandom(seed);
  const fullPool = buildTopicPool();

  let filtered = fullPool;
  if (Array.isArray(includeCategories) && includeCategories.length > 0) {
    const set = new Set(includeCategories);
    filtered = filtered.filter(item => set.has(item.category));
  }
  if (Array.isArray(excludeCategories) && excludeCategories.length > 0) {
    const set = new Set(excludeCategories);
    filtered = filtered.filter(item => !set.has(item.category));
  }
  if (filtered.length === 0) filtered = fullPool;

  const recentSet = new Set((recentTopics || []).map(t => String(t).trim().toLowerCase()));
  let pool = filtered.filter(item => !recentSet.has(item.topic.toLowerCase()));
  if (ensureNotEqualTo) {
    const avoid = String(ensureNotEqualTo).trim().toLowerCase();
    pool = pool.filter(item => item.topic.toLowerCase() !== avoid);
  }
  if (pool.length === 0) pool = filtered;

  const idx = Math.floor(random() * pool.length);
  return pool[idx];
}

/**
 * Format a concise line to append to LLM prompts, hinting at topic variety.
 * @param {string|{topic:string}} suggestion - Topic string or object with a topic field
 * @param {Object} [opts]
 * @param {string} [opts.prefix] - Text to precede the topic
 * @returns {string}
 */
export function formatTopicSuggestionForPrompt(suggestion, opts = {}) {
  const topic = typeof suggestion === 'string' ? suggestion : suggestion?.topic;
  const prefix = opts.prefix || 'Unless the topic relates to specific vocabulary, you may use the following topic suggestion for variety: ';
  if (!topic) return '';
  return `- ${prefix}: "${topic}"`;
}