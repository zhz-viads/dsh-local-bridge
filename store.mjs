import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export const VERSION = '0.1.1';
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const SESSION_ID = /^(?:session-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
export const bridgeRoot = () => path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'bridge');

export function fault(code) {
  return Object.assign(new Error(code), { code });
}

async function atomicRename(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 11) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * (attempt + 1), 80)));
    }
  }
}

export function validateRequest(value, filename) {
  if (!value || value.v !== 1 || typeof value.requestId !== 'string' || !ID.test(value.requestId) || filename !== `${value.requestId}.json`) throw fault('invalid_request');
  if (!['send', 'list'].includes(value.op)) throw fault('invalid_operation');
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt < value.createdAt) throw fault('invalid_time');
  if (value.op === 'send') {
    if (!SESSION_ID.test(value.sessionId) || !(value.from === 'dsh' ? SESSION_ID : UUID).test(value.sourceSessionId)) throw fault('invalid_session_id');
    if (!['codex', 'claude', 'dsh'].includes(value.from)) throw fault('invalid_sender');
    if (typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 32768) throw fault('invalid_text');
  }
  return value;
}

export function fingerprint(request) {
  return createHash('sha256').update(JSON.stringify({
    op: request.op, from: request.from, sessionId: request.sessionId,
    sourceSessionId: request.sourceSessionId, text: request.text,
  })).digest('hex');
}

export async function assertDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fault('unsafe_directory');
  }
}

async function ensureDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fault('unsafe_directory');
  }
}

export class BridgeStore {
  constructor(root = bridgeRoot()) { this.root = path.resolve(root); }

  async init() {
    await ensureDirectory(this.root);
    for (const name of ['inbox', 'work', 'outbox', 'rejected']) {
      await ensureDirectory(path.join(this.root, name));
    }
  }

  file(area, id) {
    if (!['inbox', 'work', 'outbox', 'rejected'].includes(area) || !ID.test(id)) throw fault('invalid_path');
    return path.join(this.root, area, `${id}.json`);
  }

  async read(file, limit = 1048576) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.readOnce(file, limit); }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES', 'file_changed'].includes(error.code) || attempt >= 11) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10 * (attempt + 1), 80)));
      }
    }
  }

  async readOnce(file, limit) {
    const relative = path.relative(this.root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fault('invalid_path');
    await assertDirectory(path.dirname(file));
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw fault('unsafe_file');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const after = await handle.stat();
      if (after.ino !== before.ino || after.dev !== before.dev || after.size > limit) throw fault('file_changed');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }

  async optional(file) {
    try { return await this.read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async write(file, value) {
    const relative = path.relative(this.root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fault('invalid_path');
    await assertDirectory(path.dirname(file));
    const existing = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw fault('unsafe_file');
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await atomicRename(temporary, file);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async names(area) {
    await assertDirectory(path.join(this.root, area));
    const items = [];
    for (const name of (await fs.readdir(path.join(this.root, area))).filter(name => name.endsWith('.json'))) {
      const info = await fs.lstat(path.join(this.root, area, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info) items.push({ name, at: info.mtimeMs });
    }
    return items.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)).map(item => item.name);
  }

  async claim(filename) {
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(filename)) throw fault('invalid_filename');
    await assertDirectory(path.join(this.root, 'inbox'));
    await assertDirectory(path.join(this.root, 'work'));
    const source = path.join(this.root, 'inbox', filename);
    const request = validateRequest(await this.read(source, 65536), filename);
    const destination = this.file('work', request.requestId);
    const previous = await this.optional(destination);
    if (previous) {
      if (fingerprint(previous) !== fingerprint(request)) throw fault('request_id_conflict');
      await fs.unlink(source);
    } else { await atomicRename(source, destination); }
    return request;
  }

  async reject(filename, code, area = 'inbox') {
    if (!['inbox', 'work'].includes(area)) throw fault('invalid_path');
    await assertDirectory(path.join(this.root, area));
    await assertDirectory(path.join(this.root, 'rejected'));
    const target = this.file('rejected', randomUUID());
    await atomicRename(path.join(this.root, area, filename), target);
    await this.write(this.file('rejected', randomUUID()), { at: Date.now(), code, filename });
  }

  async ledger(entry) {
    const file = path.join(this.root, 'ledger.jsonl');
    await assertDirectory(this.root);
    const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw fault('unsafe_ledger');
    await fs.appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  async completedIds() {
    const file = path.join(this.root, 'ledger.jsonl');
    const info = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    this.ledgerWarnings = 0;
    if (!info) return new Map();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16777216) throw fault('unsafe_ledger');
    const source = await fs.readFile(file, 'utf8');
    const entries = [];
    for (const line of source.split('\n').filter(line => line.trim())) {
      try {
        const entry = JSON.parse(line);
        if (!ID.test(entry.requestId) || !/^[a-f0-9]{64}$/.test(entry.hash || '') || typeof entry.state !== 'string') throw fault('invalid_ledger_entry');
        entries.push(entry);
      } catch { this.ledgerWarnings++; }
    }
    if (source && !source.endsWith('\n')) await fs.appendFile(file, '\n');
    return new Map(entries.filter(entry => TERMINAL.has(entry.state)).map(entry => [entry.requestId, entry]));
  }

  async prune(now = Date.now()) {
    const items = [];
    for (const filename of await this.names('outbox')) {
      if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(filename)) continue;
      const result = await this.read(path.join(this.root, 'outbox', filename));
      if (TERMINAL.has(result.state)) items.push({ filename, at: result.at });
    }
    items.sort((a, b) => b.at - a.at);
    for (const [index, item] of items.entries()) if (index >= 200 || now - item.at > 7 * 86400000) {
      await fs.unlink(path.join(this.root, 'outbox', item.filename));
      await fs.unlink(path.join(this.root, 'work', item.filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

export function isLive(status, now = Date.now()) {
  return status?.state === 'ready' && Number.isFinite(status.at) && now - status.at >= -5000 && now - status.at < 30000;
}
