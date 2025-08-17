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
  await seedIndexIfMissing(path.join(exercisesDir, 'index.json'), { items: {}, pools: {}, buckets: {}, groups: {}, stats: {} });
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
    hits: 0,
    likes: 0,
    dislikes: 0
  };
  await writeJson(filePath, record);
  idx.items[cacheKey] = { file: fileBase, createdAt: now, lastAccessAt: now, hits: 0, likes: 0, dislikes: 0, meta };
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
  return { items: {}, pools: {}, buckets: {}, groups: {}, lru: [] };
}

export async function loadExercisesIndex(layout) {
  const indexPath = path.join(layout.exercisesDir, 'index.json');
  const idx = (await readJson(indexPath)) || buildExercisesIndexDefaults();
  idx.items = idx.items || {};
  idx.pools = idx.pools || {};
  idx.buckets = idx.buckets || {};
  idx.groups = idx.groups || {};
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

function computeWeightFromCounts(likes, dislikes) {
  const l = Number(likes || 0);
  const d = Number(dislikes || 0);
  const total = l + d;
  if (total <= 0) return 1.0;
  const ratio = l / total;
  return Math.max(0.25, Math.min(1.0, ratio));
}

function computeWeightForGroup(group, currentModel) {
  if (!group) return 1.0;
  const base = computeWeightFromCounts(group.likes, group.dislikes);
  const itemModel = group?.meta?.model;
  const modelFactor = (!currentModel || !itemModel || itemModel === currentModel) ? 1.0 : 0.85;
  return base * modelFactor;
}

export function pickUnseenWeighted(shas, seenSet, idx, count, currentModel) {
  const unseen = shas.filter(s => !seenSet.has(s.slice(0, 12)));
  if (unseen.length <= count) return unseen;
  // Build weights by group ratings
  const weights = unseen.map(sha => {
    const item = idx.items[sha] || {};
    const itemModel = item?.meta?.model;
    const modelFactor = (!currentModel || !itemModel || itemModel === currentModel) ? 1.0 : 0.85;
    if (typeof item.likes === 'number' || typeof item.dislikes === 'number') {
      return computeWeightFromCounts(item.likes, item.dislikes) * modelFactor;
    }
    const groupId = item.groupId;
    const group = groupId ? idx.groups[groupId] : null;
    return computeWeightForGroup(group, currentModel) * modelFactor;
  });
  const chosen = [];
  const items = unseen.slice();
  const w = weights.slice();
  for (let k = 0; k < count && items.length > 0; k++) {
    const totalW = w.reduce((a, b) => a + b, 0) || 0;
    let r = Math.random() * (totalW || 1);
    let idxPick = 0;
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r <= 0) { idxPick = i; break; }
      if (i === w.length - 1) idxPick = i;
    }
    chosen.push(items[idxPick]);
    items.splice(idxPick, 1);
    w.splice(idxPick, 1);
  }
  return chosen;
}

export async function selectUnseenFromPool(layout, poolKey, seenSet, count) {
  const idx = await loadExercisesIndex(layout);
  const poolList = idx.pools[poolKey] || [];
  const chosen = pickUnseenWeighted(poolList, seenSet, idx, count);
  const items = [];
  for (const sha of chosen) {
    const rec = await readExerciseItem(layout, sha);
    if (rec && rec.content) items.push(rec);
  }
  return { items, shas: chosen };
}

export async function selectUnseenFromPoolGrouped(layout, poolKey, seenSet, count, currentModel) {
  const idx = await loadExercisesIndex(layout);
  const poolList = idx.pools[poolKey] || [];
  const poolSet = new Set(poolList);
  // Build groups with unseen items in group order
  const groups = [];
  const seenPrefix = (sha) => seenSet.has(String(sha).slice(0, 12));
  const groupIdsInPool = new Set();
  for (const sha of poolList) {
    const it = idx.items[sha];
    if (!it || !it.groupId) continue;
    groupIdsInPool.add(it.groupId);
  }
  for (const gid of groupIdsInPool) {
    const g = idx.groups[gid];
    if (!g || !Array.isArray(g.itemShas)) continue;
    // Keep only pool members, in group order, and unseen
    const ordered = g.itemShas.filter(s => poolSet.has(s) && !seenPrefix(s));
    if (ordered.length === 0) continue;
    const weight = computeWeightForGroup(g, currentModel);
    groups.push({ groupId: gid, unseen: ordered, weight });
  }

  const chosen = [];
  // Greedy: pick groups by weighted sampling, take as many as needed from each in order
  while (chosen.length < count && groups.length > 0) {
    const totalW = groups.reduce((acc, g) => acc + (Number(g.weight) || 0), 0) || 0;
    let r = Math.random() * (totalW || 1);
    let idxPick = 0;
    for (let i = 0; i < groups.length; i++) {
      r -= groups[i].weight;
      if (r <= 0) { idxPick = i; break; }
      if (i === groups.length - 1) idxPick = i;
    }
    const picked = groups[idxPick];
    const remaining = count - chosen.length;
    const take = picked.unseen.slice(0, remaining);
    chosen.push(...take);
    picked.unseen = picked.unseen.slice(take.length);
    if (picked.unseen.length === 0) {
      groups.splice(idxPick, 1);
    }
  }

  const items = [];
  for (const sha of chosen) {
    const rec = await readExerciseItem(layout, sha);
    if (rec && rec.content) items.push(rec);
  }
  return { items, shas: chosen };
}

function collectPoolFamilyShas(idx, family) {
  const { type, language, level, challengeMode, schemaVersion, promptSha12 } = family;
  const keys = Object.keys(idx.pools || {});
  const result = [];
  for (const key of keys) {
    const parts = String(key).split(':');
    if (parts.length !== 7) continue;
    const [t, lang, lvl, chall, /*model*/, ver, sha12] = parts;
    if (t === type && lang === language && lvl === level && chall === String(challengeMode) && ver === String(schemaVersion) && sha12 === promptSha12) {
      const list = idx.pools[key] || [];
      for (const sha of list) result.push(sha);
    }
  }
  // Dedupe preserving order
  const seen = new Set();
  const deduped = [];
  for (const sha of result) { if (!seen.has(sha)) { seen.add(sha); deduped.push(sha); } }
  return deduped;
}

export async function selectUnseenCrossModel(layout, family, seenSet, count, currentModel) {
  const idx = await loadExercisesIndex(layout);
  const candidates = collectPoolFamilyShas(idx, family);
  const chosen = pickUnseenWeighted(candidates, seenSet, idx, count, currentModel);
  const items = [];
  for (const sha of chosen) {
    const rec = await readExerciseItem(layout, sha);
    if (rec && rec.content) items.push(rec);
  }
  return { items, shas: chosen };
}

export async function selectUnseenCrossModelGrouped(layout, family, seenSet, count, currentModel) {
  const idx = await loadExercisesIndex(layout);
  const candidates = collectPoolFamilyShas(idx, family);
  const candidateSet = new Set(candidates);
  const groups = [];
  const seenPrefix = (sha) => seenSet.has(String(sha).slice(0, 12));
  const candidateGroupIds = new Set();
  for (const sha of candidates) {
    const it = idx.items[sha];
    if (!it || !it.groupId) continue;
    candidateGroupIds.add(it.groupId);
  }
  for (const gid of candidateGroupIds) {
    const g = idx.groups[gid];
    if (!g || !Array.isArray(g.itemShas)) continue;
    const ordered = g.itemShas.filter(s => candidateSet.has(s) && !seenPrefix(s));
    if (ordered.length === 0) continue;
    const weight = computeWeightForGroup(g, currentModel);
    groups.push({ groupId: gid, unseen: ordered, weight });
  }
  const chosen = [];
  while (chosen.length < count && groups.length > 0) {
    const totalW = groups.reduce((acc, g) => acc + (Number(g.weight) || 0), 0) || 0;
    let r = Math.random() * (totalW || 1);
    let idxPick = 0;
    for (let i = 0; i < groups.length; i++) {
      r -= groups[i].weight;
      if (r <= 0) { idxPick = i; break; }
      if (i === groups.length - 1) idxPick = i;
    }
    const picked = groups[idxPick];
    const remaining = count - chosen.length;
    const take = picked.unseen.slice(0, remaining);
    chosen.push(...take);
    picked.unseen = picked.unseen.slice(take.length);
    if (picked.unseen.length === 0) {
      groups.splice(idxPick, 1);
    }
  }
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

export async function addExercisesToPool(layout, { type, poolKey, bucketKey, language, level, challengeMode, grammarTopic, model, schemaVersion }, items, perTypeLimit = 100, groupIdInput = null) {
  const idx = await loadExercisesIndex(layout);
  const now = new Date().toISOString();
  idx.pools[poolKey] = idx.pools[poolKey] || [];
  idx.buckets[bucketKey] = idx.buckets[bucketKey] || [];
  const groupId = groupIdInput || sha256Hex(`${type}:${language}:${level}:${challengeMode}:${grammarTopic || ''}:${model}:${schemaVersion}:${now}:${Math.random()}`).slice(0, 16);
  // Initialize group meta
  idx.groups[groupId] = idx.groups[groupId] || { type, poolKey, meta: { language, level, challengeMode, grammarTopic, model, schemaVersion }, itemShas: [], createdAt: now, likes: 0, dislikes: 0 };
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
      hits: 0,
      groupId
    };
    try {
      await writeJson(filePath, record);
    } catch {}
    idx.items[exerciseSha] = { file, type, createdAt: now, lastAccessAt: now, hits: 0, likes: 0, dislikes: 0, meta: record.meta, groupId };
    if (!idx.pools[poolKey].includes(exerciseSha)) idx.pools[poolKey].push(exerciseSha);
    if (!idx.buckets[bucketKey].includes(exerciseSha)) idx.buckets[bucketKey].push(exerciseSha);
    if (!idx.groups[groupId].itemShas.includes(exerciseSha)) idx.groups[groupId].itemShas.push(exerciseSha);
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
  return { addedShas, groupId };
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


// -----------------------------
// Ratings: explanations and exercise groups
// -----------------------------

export async function rateExplanation(layout, cacheKey, isLike = true) {
  try {
    const indexPath = path.join(layout.explanationsDir, 'index.json');
    const idx = (await readJson(indexPath)) || { items: {} };
    if (!idx.items[cacheKey]) return false;
    const entry = idx.items[cacheKey];
    entry.likes = Number(entry.likes || 0) + (isLike ? 1 : 0);
    entry.dislikes = Number(entry.dislikes || 0) + (!isLike ? 1 : 0);
    idx.items[cacheKey] = entry;
    await writeJson(indexPath, idx);
    // Update record file too, if exists
    try {
      const filePath = path.join(layout.explanationsDir, 'items', entry.file);
      const rec = (await readJson(filePath)) || {};
      rec.likes = Number(rec.likes || 0) + (isLike ? 1 : 0);
      rec.dislikes = Number(rec.dislikes || 0) + (!isLike ? 1 : 0);
      await writeJson(filePath, rec);
    } catch {}
    return true;
  } catch {
    return false;
  }
}

export async function rateExerciseGroup(layout, groupId, isLike = true) {
  const idx = await loadExercisesIndex(layout);
  if (!idx.groups[groupId]) return false;
  const g = idx.groups[groupId];
  g.likes = Number(g.likes || 0) + (isLike ? 1 : 0);
  g.dislikes = Number(g.dislikes || 0) + (!isLike ? 1 : 0);
  idx.groups[groupId] = g;
  // Also roll the rating down to each contained item in the index for fast weighting
  const itemShas = Array.isArray(g.itemShas) ? g.itemShas : [];
  for (const sha of itemShas) {
    if (!idx.items[sha]) continue;
    const it = idx.items[sha];
    it.likes = Number(it.likes || 0) + (isLike ? 1 : 0);
    it.dislikes = Number(it.dislikes || 0) + (!isLike ? 1 : 0);
    idx.items[sha] = it;
    // Update item file too (best-effort)
    try {
      const file = makeExerciseFileName(sha);
      const filePath = path.join(layout.exerciseItemsDir, file);
      const rec = (await readJson(filePath)) || {};
      rec.likes = Number(rec.likes || 0) + (isLike ? 1 : 0);
      rec.dislikes = Number(rec.dislikes || 0) + (!isLike ? 1 : 0);
      await writeJson(filePath, rec);
    } catch {}
  }
  await saveExercisesIndex(layout, idx);
  return true;
}



