import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The launcher holds the installation's process lock. This queue additionally
// serializes independent profile changes inside that one process.
export async function createLocalProfileStore(authDir) {
  const directory = await fs.realpath(authDir);
  const filename = path.join(directory, 'local-profiles.vault');
  const key = await fs.readFile(path.join(directory, 'encryption.key'));
  const aad = Buffer.from('language-ai-local-profiles:v1');
  let state;
  try {
    if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('Saved profiles must not be a symbolic link.');
    const envelope = JSON.parse(await fs.readFile(filename, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8'));
    if (state.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/.test(state.hostId) || !Number.isSafeInteger(state.nextNumber) || state.nextNumber < 1 || !state.profiles || Array.isArray(state.profiles) || typeof state.profiles !== 'object') throw new Error('Invalid saved profiles.');
    await fs.chmod(filename, 0o600);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('Saved ChatGPT profiles could not be read. Restore the private authentication directory before continuing.', { cause: e });
    state = { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, nextNumber: 1, profiles: {} };
  }
  async function persist(next) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    const temporary = `${filename}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
      state = next;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  await persist(state);
  let queue = Promise.resolve();
  return {
    hostId: state.hostId,
    get: id => structuredClone(state.profiles[id] ?? null),
    list: () => structuredClone(Object.values(state.profiles)),
    async put(profile, replaceId) {
      const update = queue.catch(() => {}).then(async () => {
        const next = structuredClone(state);
        const existing = next.profiles[profile.accountId] ?? next.profiles[replaceId];
        if (replaceId && replaceId !== profile.accountId) delete next.profiles[replaceId];
        next.profiles[profile.accountId] = { ...structuredClone(profile), number: existing?.number ?? next.nextNumber++ };
        await persist(next);
        return structuredClone(next.profiles[profile.accountId]);
      });
      queue = update;
      return update;
    },
    flush: () => queue
  };
}
