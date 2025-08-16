import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function getCacheDir(envCacheDir, fallbackDir) {
  const dir = envCacheDir && String(envCacheDir).trim() ? envCacheDir : fallbackDir;
  return dir || '/data';
}

export async function ensureCacheLayout(cacheDir) {
  const explanationsDir = path.join(cacheDir, 'explanations');
  const explanationItemsDir = path.join(explanationsDir, 'items');
  const exercisesDir = path.join(cacheDir, 'exercises');
  const exerciseItemsDir = path.join(exercisesDir, 'items');
  const imagesDir = path.join(cacheDir, 'images');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(explanationsDir, { recursive: true });
  await fs.mkdir(exerciseItemsDir, { recursive: true });
  await fs.mkdir(explanationItemsDir, { recursive: true });
  await fs.mkdir(imagesDir, { recursive: true });
  // Seed empty indexes if missing
  await seedIndexIfMissing(path.join(explanationsDir, 'index.json'), { items: {}, stats: {} });
  await seedIndexIfMissing(path.join(exercisesDir, 'index.json'), { items: {}, pools: {}, buckets: {}, stats: {} });
  await seedIndexIfMissing(path.join(imagesDir, 'index.json'), { items: {} });
  return { explanationsDir, explanationItemsDir, exercisesDir, exerciseItemsDir, imagesDir };
}

async function seedIndexIfMissing(indexPath, initial) {
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, JSON.stringify(initial, null, 2), 'utf8');
  }
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function readJson(filePath, fallback = null) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function downloadImageToCache({ imagesDir, exerciseSha, url, fetchImpl, publicBase = '/cache/images' }) {
  if (!exerciseSha || !url) throw new Error('exerciseSha and url are required');
  const res = await fetchImpl(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to download image (${res.status}): ${text}`);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const ext = guessExtension(url, contentType) || '.bin';
  const filename = `${exerciseSha}${ext}`;
  const destPath = path.join(imagesDir, filename);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  const indexPath = path.join(imagesDir, 'index.json');
  const idx = (await readJson(indexPath)) || { items: {} };
  idx.items[exerciseSha] = { path: destPath, filename, contentType: contentType || null, createdAt: new Date().toISOString() };
  await writeJson(indexPath, idx);
  const localUrl = `${publicBase.replace(/\/$/, '')}/${filename}`;
  return { localPath: destPath, filename, ext, contentType, localUrl };
}

function guessExtension(url, contentType) {
  const byType = contentType.startsWith('image/') ? `.${contentType.split('/')[1].split(';')[0]}` : '';
  const byUrl = (() => {
    try {
      const u = new URL(url);
      const m = (u.pathname || '').match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i);
      return m ? `.${m[1].toLowerCase()}` : '';
    } catch { return ''; }
  })();
  // Prefer URL-specified ext if present, else content-type
  return byUrl || byType || '';
}

// -----------------------------
// Explanations persistent cache
// -----------------------------

export async function getExplanation(layout, cacheKey) {
  const indexPath = path.join(layout.explanationsDir, 'index.json');
  const idx = (await readJson(indexPath)) || { items: {}, lru: [] };
  const entry = idx.items?.[cacheKey];
  if (!entry) return null;
  try {
    const filePath = path.join(layout.explanationsDir, 'items', entry.file);
    const data = await readJson(filePath);
    // Touch LRU and stats
    entry.hits = (entry.hits || 0) + 1;
    entry.lastAccessAt = new Date().toISOString();
    idx.lru = (idx.lru || []).filter(k => k !== cacheKey);
    idx.lru.push(cacheKey);
    // Increment stats by meta key
    try {
      const m = entry.meta || {};
      const statKey = `${m.language || 'unknown'}|${m.level || 'unknown'}|${m.challengeMode ? '1' : '0'}|${m.grammarConcept || 'unknown'}`;
      idx.stats = idx.stats || {};
      const s = idx.stats[statKey] || { hits: 0, generations: 0 };
      s.hits = (s.hits || 0) + 1;
      idx.stats[statKey] = s;
    } catch {}
    await writeJson(indexPath, idx);
    return data;
  } catch {
    // If the file is missing, clean up the index
    delete idx.items[cacheKey];
    idx.lru = (idx.lru || []).filter(k => k !== cacheKey);
    await writeJson(indexPath, idx);
    return null;
  }
}

export async function setExplanation(layout, cacheKey, meta, content, maxCapacity = 1000) {
  const indexPath = path.join(layout.explanationsDir, 'index.json');
  const idx = (await readJson(indexPath)) || { items: {}, lru: [] };
  const fileBase = sha256Hex(cacheKey).slice(0, 16) + '.json';
  const filePath = path.join(layout.explanationsDir, 'items', fileBase);
  const now = new Date().toISOString();
  const record = {
    key: cacheKey,
    meta,
    content,
    createdAt: now,
    lastAccessAt: now,
    hits: 0
  };
  await writeJson(filePath, record);
  idx.items[cacheKey] = { file: fileBase, createdAt: now, lastAccessAt: now, hits: 0, meta };
  idx.lru = (idx.lru || []).filter(k => k !== cacheKey);
  idx.lru.push(cacheKey);
  // Prune LRU if over capacity
  while ((idx.lru || []).length > maxCapacity) {
    const oldKey = idx.lru.shift();
    if (oldKey && idx.items[oldKey]) {
      const oldFile = idx.items[oldKey].file;
      delete idx.items[oldKey];
      try { await fs.unlink(path.join(layout.explanationsDir, 'items', oldFile)); } catch {}
    }
  }
  await writeJson(indexPath, idx);
}

// -----------------------------
// Exercises persistent cache
// -----------------------------

function buildExercisesIndexDefaults() {
  return { items: {}, pools: {}, buckets: {}, lru: [] };
}

export async function loadExercisesIndex(layout) {
  const indexPath = path.join(layout.exercisesDir, 'index.json');
  const idx = (await readJson(indexPath)) || buildExercisesIndexDefaults();
  idx.items = idx.items || {};
  idx.pools = idx.pools || {};
  idx.buckets = idx.buckets || {};
  idx.lru = idx.lru || [];
  return idx;
}

export async function saveExercisesIndex(layout, idx) {
  const indexPath = path.join(layout.exercisesDir, 'index.json');
  await writeJson(indexPath, idx);
}

export function makeBucketKey({ type, language, level, challengeMode, grammarTopic }) {
  return `${type}:${language}:${level}:${challengeMode}:${grammarTopic || 'unknown'}`;
}

export function makeExerciseFileName(exerciseSha) {
  return `${exerciseSha}.json`;
}

export async function readExerciseItem(layout, exerciseSha) {
  const file = makeExerciseFileName(exerciseSha);
  const filePath = path.join(layout.exerciseItemsDir, file);
  return await readJson(filePath, null);
}

export function pickUnseen(shas, seenSet, count) {
  const unseen = shas.filter(s => !seenSet.has(s.slice(0, 12)));
  // Shuffle a copy
  for (let i = unseen.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
  }
  return unseen.slice(0, count);
}

export async function selectUnseenFromPool(layout, poolKey, seenSet, count) {
  const idx = await loadExercisesIndex(layout);
  const poolList = idx.pools[poolKey] || [];
  const chosen = pickUnseen(poolList, seenSet, count);
  const items = [];
  for (const sha of chosen) {
    const rec = await readExerciseItem(layout, sha);
    if (rec && rec.content) items.push(rec);
  }
  return { items, shas: chosen };
}

export async function touchExercises(layout, exerciseShas) {
  if (!Array.isArray(exerciseShas) || exerciseShas.length === 0) return;
  const idx = await loadExercisesIndex(layout);
  const now = new Date().toISOString();
  for (const sha of exerciseShas) {
    if (idx.items[sha]) {
      idx.items[sha].lastAccessAt = now;
      idx.items[sha].hits = (idx.items[sha].hits || 0) + 1;
    }
  }
  // Maintain global LRU list of shas
  for (const sha of exerciseShas) {
    idx.lru = (idx.lru || []).filter(x => x !== sha);
    idx.lru.push(sha);
  }
  await saveExercisesIndex(layout, idx);
}

async function evictFromBucketIfNeeded(layout, idx, bucketKey, perTypeLimit) {
  const list = idx.buckets[bucketKey] || [];
  if (list.length <= perTypeLimit) return;
  // Evict least recently used within this bucket using idx.items lastAccessAt
  const candidates = list.map(sha => ({ sha, ts: Date.parse(idx.items[sha]?.lastAccessAt || 0) || 0 }));
  candidates.sort((a, b) => a.ts - b.ts);
  while (idx.buckets[bucketKey].length > perTypeLimit && candidates.length > 0) {
    const victim = candidates.shift();
    if (!victim) break;
    const sha = victim.sha;
    // Attempt to read record for image cleanup
    try {
      const rec = await readExerciseItem(layout, sha);
      if (rec?.localImagePath) {
        try { await fs.unlink(rec.localImagePath); } catch {}
      }
    } catch {}
    // Remove from pools
    for (const k of Object.keys(idx.pools)) {
      idx.pools[k] = (idx.pools[k] || []).filter(x => x !== sha);
    }
    // Remove from bucket
    idx.buckets[bucketKey] = (idx.buckets[bucketKey] || []).filter(x => x !== sha);
    // Delete file
    const file = makeExerciseFileName(sha);
    try { await fs.unlink(path.join(layout.exerciseItemsDir, file)); } catch {}
    // Delete item
    delete idx.items[sha];
    // TODO: if item had localImagePath, also unlink it (requires reading the record prior). For performance, skip here.
  }
}

export async function addExercisesToPool(layout, { type, poolKey, bucketKey, language, level, challengeMode, grammarTopic, model, schemaVersion }, items, perTypeLimit = 100) {
  const idx = await loadExercisesIndex(layout);
  const now = new Date().toISOString();
  idx.pools[poolKey] = idx.pools[poolKey] || [];
  idx.buckets[bucketKey] = idx.buckets[bucketKey] || [];
  const addedShas = [];
  for (const content of items) {
    const exerciseSha = sha256Hex(JSON.stringify(content) + `\n${type}\n${language}\n${level}\n${model}\n${schemaVersion}`);
    const file = makeExerciseFileName(exerciseSha);
    const filePath = path.join(layout.exerciseItemsDir, file);
    // If already exists, skip writing content but still add to pool for completeness
    const record = {
      exerciseSha,
      type,
      meta: { language, level, challengeMode, grammarTopic, model, schemaVersion },
      content,
      createdAt: now,
      lastAccessAt: now,
      hits: 0
    };
    try {
      await writeJson(filePath, record);
    } catch {}
    idx.items[exerciseSha] = { file, type, createdAt: now, lastAccessAt: now, hits: 0, meta: record.meta };
    if (!idx.pools[poolKey].includes(exerciseSha)) idx.pools[poolKey].push(exerciseSha);
    if (!idx.buckets[bucketKey].includes(exerciseSha)) idx.buckets[bucketKey].push(exerciseSha);
    addedShas.push(exerciseSha);
  }
  // Enforce per-type bucket cap (global per type/language/level/challenge/grammarTopic)
  await evictFromBucketIfNeeded(layout, idx, bucketKey, perTypeLimit);
  // Update generation stats
  try {
    const statKey = `${type}|${language}|${level}|${challengeMode ? '1' : '0'}|${grammarTopic || 'unknown'}`;
    idx.stats = idx.stats || {};
    const s = idx.stats[statKey] || { hits: 0, generations: 0 };
    s.generations = (s.generations || 0) + addedShas.length;
    idx.stats[statKey] = s;
  } catch {}
  await saveExercisesIndex(layout, idx);
  return addedShas;
}

export async function updateExerciseRecord(layout, exerciseSha, updater) {
  const file = makeExerciseFileName(exerciseSha);
  const filePath = path.join(layout.exerciseItemsDir, file);
  const rec = await readJson(filePath, null);
  if (!rec) return false;
  const updated = typeof updater === 'function' ? updater(rec) : rec;
  await writeJson(filePath, updated);
  return true;
}

export async function purgeOutdatedSchemas(layout, schemaVersions) {
  // Explanations
  try {
    const expIndexPath = path.join(layout.explanationsDir, 'index.json');
    const expIdx = (await readJson(expIndexPath)) || { items: {}, lru: [] };
    const toDelete = [];
    for (const [key, entry] of Object.entries(expIdx.items || {})) {
      const v = Number(entry?.meta?.schemaVersion || 0);
      if (v !== Number(schemaVersions.explanation || 1)) {
        toDelete.push({ key, file: entry.file });
      }
    }
    for (const d of toDelete) {
      try { await fs.unlink(path.join(layout.explanationsDir, 'items', d.file)); } catch {}
      delete expIdx.items[d.key];
      expIdx.lru = (expIdx.lru || []).filter(k => k !== d.key);
    }
    if (toDelete.length > 0) await writeJson(expIndexPath, expIdx);
  } catch {}

  // Exercises
  try {
    const exIdx = await loadExercisesIndex(layout);
    const desiredVersion = (type) => Number(schemaVersions[type] || 1);
    const toRemove = [];
    for (const [sha, entry] of Object.entries(exIdx.items || {})) {
      const type = entry?.type || entry?.meta?.type;
      const v = Number(entry?.meta?.schemaVersion || 0);
      if (!type) continue;
      if (v !== desiredVersion(type)) {
        toRemove.push(sha);
      }
    }
    for (const sha of toRemove) {
      // Try to read record to find localImagePath for cleanup
      try {
        const rec = await readExerciseItem(layout, sha);
        if (rec?.localImagePath) {
          try { await fs.unlink(rec.localImagePath); } catch {}
        }
      } catch {}
      const file = makeExerciseFileName(sha);
      try { await fs.unlink(path.join(layout.exerciseItemsDir, file)); } catch {}
      delete exIdx.items[sha];
      for (const k of Object.keys(exIdx.pools)) exIdx.pools[k] = (exIdx.pools[k] || []).filter(x => x !== sha);
      for (const k of Object.keys(exIdx.buckets)) exIdx.buckets[k] = (exIdx.buckets[k] || []).filter(x => x !== sha);
      exIdx.lru = (exIdx.lru || []).filter(x => x !== sha);
    }
    if (toRemove.length > 0) await saveExercisesIndex(layout, exIdx);
  } catch {}
}

export async function incrementExerciseHits(layout, type, language, level, challengeMode, grammarTopic, count) {
  const idx = await loadExercisesIndex(layout);
  idx.stats = idx.stats || {};
  const key = `${type}|${language}|${level}|${challengeMode ? '1' : '0'}|${grammarTopic || 'unknown'}`;
  const s = idx.stats[key] || { hits: 0, generations: 0 };
  s.hits = (s.hits || 0) + (Number(count) || 0);
  idx.stats[key] = s;
  await saveExercisesIndex(layout, idx);
}



