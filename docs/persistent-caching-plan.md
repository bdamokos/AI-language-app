## Persistent Caching and Analytics Plan

This document outlines how we will implement persistent caching for explanations and exercises, including deployment changes, data model, API changes, cookie-based per-user uniqueness for exercises, analytics, schema-versioning, and LRU eviction.

### Goals
- Persist cache across deployments via a Docker volume.
- Cache explanations keyed by language, level, challenge mode, grammar concept, model, prompt SHA, and schema version.
- Cache exercises with unique exercise IDs, per-user uniqueness using cookies, and LRU eviction with analytics counters persisted.
- Handle Cloze images by downloading remote image URLs to the server and serving locally; purge images when cache items are evicted.
- Support schema versions per exercise type and explanations; purge old-schema entries on startup.

### High-level Architecture
- Add a persistent directory mounted into the container at `/data` (configurable via `CACHE_DIR`, default `/data`).
- File-backed cache with lightweight JSON indexes:
  - `/data/explanations/index.json`: index + recency list + analytics counters
  - `/data/explanations/items/<key>.json`: one file per explanation
  - `/data/exercises/index.json`: global exercise index, per-type pools, recency, analytics
  - `/data/exercises/items/<sha>.json`: one file per exercise item (content + metadata)
  - `/data/images/<exerciseSha>.<ext>`: stored images for Cloze items (when applicable)
  - `/data/stats.json`: global counters by language, level, type, grammar topic (optional convenience; mirrors data from indexes)

We will keep item payloads in separate files to simplify eviction and reduce index churn. Index files hold metadata, recency queue, and mappings.

### Keys, Hashing and IDs
- Hash function: SHA-256; store lowercase hex; use first 12 chars for compact IDs when needed.
- Prompt SHA: `sha256(system + '\n' + user + '\n' + schemaName + '\n' + JSON.stringify(languageContext))`
- Explanation cache key: `exp:{language}:{level}:{challengeMode}:{grammarConcept}:{model}:{schemaVersion}:{promptSha12}`
- Exercise unique ID (exerciseSha): `sha256(JSON.stringify(item) + '\n' + type + '\n' + language + '\n' + level + '\n' + model + '\n' + schemaVersion)`; store prefix 12 for cookies.

### Record Shapes
- Explanation record (items/<key>.json):
  - `key`: string (matches index key)
  - `meta`: `{ language, level, challengeMode, grammarConcept, model, schemaVersion, promptSha, promptSha12 }`
  - `content`: the explanation JSON returned to the client
  - `createdAt`: ISO datetime
  - `lastAccessAt`: ISO datetime
  - `hits`: number

- Exercises:
  - Index groups exercises by `type` and `poolKey` to support batch cache reuse:
    - `poolKey`: `{ type, language, level, challengeMode, model, schemaVersion, promptSha12 }`
  - Each exercise item file (items/<exerciseSha>.json):
    - `exerciseSha`: string (full)
    - `type`: `fib | mcq | cloze | cloze_mixed | writing_prompts`
    - `meta`: `{ language, level, challengeMode, model, schemaVersion, promptSha, promptSha12, grammarTopic? }`
    - `content`: the single exercise item
    - `createdAt`, `lastAccessAt`, `hits`
    - `localImagePath?`: string (when Cloze image downloaded)

### LRU + Limits
- Explanations: limit 1000 entries. Evict least recently used (by `lastAccessAt`) while preserving analytics counters. Purge removes `items/<key>.json` and index entry.
- Exercises: limit 100 items per `type` (configurable). LRU across that type. When evicting Cloze with `localImagePath`, delete the corresponding file, and remove any orphan images via periodic cleanup (optional).

### Analytics / Stats
- Persisted counters incremented on both cache hits and new generations:
  - Per explanation: by `{ language, level, challengeMode, grammarConcept }`
  - Per exercise: by `{ language, level, challengeMode, type, grammarTopic? }`
- Store counters in the indexes for integrity; mirror summary to `/data/stats.json` for quick reads.

### Schema Versioning
- Introduce a shared version map to be imported by both server and client:
  - `shared/schemaVersions.js` exporting:
    - `schemaVersions = { explanation: 1, fib: 1, mcq: 1, cloze: 1, cloze_mixed: 1, writing_prompts: 1 }`
- Each exercise component and the explanation generator will include its schema version in generation metadata/requests and accept it from the shared map.
- On server startup:
  - Load `schemaVersions` and scan indexes
  - Purge any cached item whose `schemaVersion` does not match the current version for its type

Note: This keeps a single source of truth for versions, avoids trying to import JSX into Node at runtime, and still requires a manual bump whenever a schema changes.

### API Changes
- Cookie parsing: add cookie parsing middleware (e.g., `cookie-parser`), or manual parsing.
- Reuse `/api/generate` and add caching behavior by `schemaName` to avoid widespread client changes. Server will compute prompt SHA and apply cache logic based on the type inferred from `schemaName`.
  - Type inference:
    - `schemaName === 'explanation'` → explanation flow
    - `schemaName === 'fib_list'` → `fib`
    - `schemaName === 'mcq_list'` → `mcq`
    - `schemaName` starts with `cloze_single_` → `cloze` (count=1)
    - `schemaName` starts with `cloze_mixed_single_` → `cloze_mixed` (count=1)
    - `schemaName === 'writing_prompts_list'` → `writing_prompts`

- Request envelope (unchanged for clients that already send `system`, `user`, `jsonSchema`, `schemaName`). Server derives `language`, `level`, `challengeMode` by parsing the prompt (or we add optional `metadata` in body – see open questions).

- Explanation flow:
  1) Build `promptSha` from incoming `system`+`user`+`schemaName`+`languageContext`.
  2) Compute key including grammar concept, model, schema version.
  3) On hit: return cached content; update `hits` and `lastAccessAt`; update analytics counters.
  4) On miss: call LLM, store file, update index, then return.

- Exercise flow:
  1) Identify `type` and requested `count` from the prompt (or new optional `metadata`), compute `promptSha`.
  2) Read cookie `seen_exercises_<type>`: CSV of up to N short SHAs (e.g., N=50) to avoid cookie bloat.
  3) For the corresponding pool (same type/language/level/challenge/model/schemaVersion/promptSha12), fetch unseen items. If enough, return a random selection. If not enough, call LLM for the shortfall, assign `exerciseSha` to each item, persist items to files, update pool, then return all requested.
  4) Update `seen_exercises_<type>` with the returned `exerciseSha12` values (append, dedupe, cap length).
  5) Update analytics counters and item `hits/lastAccessAt`.

- Cloze image handling:
  - New endpoint `POST /api/cache/exercise-image` with body `{ exerciseSha, url }` downloads the image into `/data/images/<exerciseSha>.<ext>` and returns `{ localUrl: '/cache/images/<exerciseSha>.<ext>' }`.
  - Static serving: `app.use('/cache/images', express.static(path.join(CACHE_DIR, 'images')))`.
  - When evicting a Cloze exercise with `localImagePath`, delete the file.
  - Client flow: after generating an image (via `/api/runware/generate` or `/api/falai/generate`), call this endpoint to persist it. Store the returned `localUrl` on the item in client state for future renders.

### Deployment Changes
- Dockerfile:
  - Add `ENV CACHE_DIR=/data`.
  - Ensure `/data` exists at runtime stage (`RUN mkdir -p /data`).
  - Optionally create a non-root user and chown `/data` (future hardening).

- docker-compose.yml:
  - Add a volume mount under service `app`:
    - `volumes:`
      - `${CACHE_HOST_DIR:-/var/lib/language-ai-app}:/data`
  - Keep existing envs; optionally add `CACHE_DIR=/data`, `CACHE_EXPLANATIONS_MAX`, `CACHE_EXERCISES_PER_TYPE_MAX`.

- deploy.sh:
  - Ensure remote host directory exists: `mkdir -p ${CACHE_HOST_DIR:-/var/lib/language-ai-app}` before `docker-compose up`.
  - Copy `.env` and `docker-compose.yml` already handled; document new `CACHE_HOST_DIR` variable in `.env`.

### Startup Tasks
- On server boot:
  - Create directories: `/data/explanations/items`, `/data/exercises/items`, `/data/images`.
  - Initialize or load indexes.
  - Load `shared/schemaVersions.js` and purge entries with mismatched versions.
  - Optional: garbage-collect orphan images.

### Configuration
- Env vars:
  - `CACHE_DIR` (default `/data`)
  - `CACHE_EXPLANATIONS_MAX` (default `1000`)
  - `CACHE_EXERCISES_PER_TYPE_MAX` (default `100`)
  - `COOKIE_MAX_SEEN_PER_TYPE` (default `50` to keep cookies <4KB total)

### Milestones / Checklist
- [ ] Create `shared/schemaVersions.js` and import in components and server
- [x] Create `shared/schemaVersions.js` and import in components and server
- [x] Add file-backed cache module `server/cacheStore.js` (indexes, read/write, LRU, purge)
- [x] Extend `/api/generate` with:
  - [x] Explanation persistent caching (read/write)
  - [x] Exercise persistent caching, per-user unseen selection via cookie (versioned), random selection, generation fallback
  - [ ] Stats updates
- [x] Add `POST /api/cache/exercise-image` and static serving at `/cache/images`; update `useImageGeneration.js` to call this and return local URL with `exerciseSha`
- [x] Dockerfile: add `ENV CACHE_DIR=/data` and create folder in runtime image
- [x] docker-compose.yml: add volume `${CACHE_HOST_DIR:-/var/lib/language-ai-app}:/data`
- [x] deploy.sh: create remote `${CACHE_HOST_DIR}` folder prior to `docker-compose up`
- [ ] Startup purge by schema versions and optional orphan image GC
- [ ] Docs/README updates

### Decisions
- **Model in key**: include model in cache key for both explanations and exercises.
- **Cookie size and expiry**: use short SHA prefixes (6–12 chars). Cap seen-list per type and set cookie expiry to 30 days (rolling on revisit).
- **Exercise limit scope**: limit is global per `type/language/level/challenge/grammar concept`; counts across models. Make limits configurable.
- **Schema versions**: use a shared `shared/schemaVersions.js` and document it for future updates.
- **Cloze images**: `useImageGeneration.js` will persist images immediately to server with `exerciseSha` and update the cached exercise with `image` metadata; client will receive local URL.

### Notes / Rationale
- File-backed JSON is simple, transparent, and adequate for our scale. We can swap to a small embedded DB (e.g., SQLite) later if needed without changing the high-level API.
- Using a shared schema version map guarantees the server can purge outdated items without needing to parse JSX.
- Keeping per-exercise files simplifies eviction and handling image deletion.


