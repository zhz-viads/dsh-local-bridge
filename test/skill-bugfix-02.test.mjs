import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.mjs';
import { findSessions, main, readResult } from '../cli.mjs';
import { BridgeStore } from '../store.mjs';

const ROW = { id: 'aaaaaaaa-0000-4000-8000-000000000001', thread_name: '目标', updated_at: '2026-10-20T00:00:00Z' };
const SECOND = { ...ROW, id: 'aaaaaaaa-0000-4000-8000-000000000002' };
const shell = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');

async function fixture(t, contents = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-bugfix-02-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  const file = path.join(root, 'session_index.jsonl');
  await fs.writeFile(file, contents);
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(root, { recursive: true });
  });
  return { root, file };
}

test('X8 bridge prompt requires all task items without arbitrary reply caps', () => {
  let prompt;
  apply({ connection: { createPeer: () => ({}) }, systemPrompt: { section: section => { prompt = section.text; } }, effect() {} });
  assert.match(prompt, /按任务卡.*逐条写全/);
  assert.match(prompt, /任务卡或发送方指定/);
  assert.match(prompt, /32\s*KB/);
  assert.doesNotMatch(prompt, /最多\s*5\s*条|约\s*800\s*字|回复要短|无限制/);
  assert.match(prompt, /最后一条回复/);
  assert.match(prompt, /不要再用 to-claude \/ to-codex 重发/);
  assert.match(prompt, /三方头脑风暴/);
  assert.match(prompt, /每轮回一次/);
});

test('X8 replies can exceed 32 KiB while the 1 MiB outbox read boundary stays intact', async t => {
  const { root } = await fixture(t);
  const store = new BridgeStore(root);
  await store.init();
  const text = 'r'.repeat(40000);
  await store.write(store.file('outbox', 'large-reply'), { state: 'completed', text });
  assert.equal((await readResult(store, 'large-reply')).text, text);
  await fs.writeFile(store.file('outbox', 'oversized-reply'), JSON.stringify({ state: 'completed', text: 'r'.repeat(1048576) }));
  await assert.rejects(readResult(store, 'oversized-reply'), { code: 'unsafe_file' });
});

test('X9 help explicitly documents interactive-only Claude delivery', async () => {
  assert.match((await main(['help'])).commands['to-claude'], /interactive/);
});

test('X9 CLI preserves the interactive-only adapter error without contacting a peer', async t => {
  const { root } = await fixture(t);
  const previousHome = process.env.DSH_HOME;
  const original = childProcess.execFile;
  let calls = 0;
  process.env.DSH_HOME = root;
  childProcess.execFile = (...args) => {
    calls++;
    assert.ok(args[1].includes('-SessionId'));
    const error = Object.assign(new Error('adapter rejected target kind'), { code: 1, stderr: 'claude_session_requires_interactive' });
    args.at(-1)(error);
  };
  syncBuiltinESMExports();
  try {
    const { main: isolatedMain } = await import('../cli.mjs?interactive-regression');
    await assert.rejects(isolatedMain(['to-claude', '--session', ROW.id, '--source-session', `session-${SECOND.id}`, '--text', 'fixture']),
      { code: 'claude_session_requires_interactive' });
    assert.equal(calls, 1);
    const names = await fs.readdir(path.join(root, 'bridge'));
    assert.equal(names.some(name => name.startsWith('outbound-')), false);
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('X9 adapter rejects non-interactive kinds and retains process/protocol/start-time guards', async t => {
  const { root } = await fixture(t);
  const message = path.join(root, 'message.txt');
  await fs.writeFile(message, 'fixture');
  const helper = fileURLToPath(new URL('../claude-peer.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  for (const [kind, processName, protocol, expected] of [
    ['bg', 'claude', 1, 'claude_session_requires_interactive'],
    ['', 'claude', 1, 'claude_session_requires_interactive'],
    ['interactive', 'other', 1, 'unsupported_claude_session'],
    ['interactive', 'claude', 2, 'unsupported_claude_session'],
    ['interactive', 'claude', 1, 'claude_process_changed'],
  ]) {
    const script = `
      function Get-ChildItem { param($LiteralPath, $Filter, [switch]$File) if ($Filter -ne '*.json') { throw 'unexpected_key_access' }; [pscustomobject]@{ FullName='fixture-registry.json' } }
      function Get-Content { param($LiteralPath, [switch]$Raw) if ($LiteralPath -ne 'fixture-registry.json') { throw 'unexpected_registry_access' }; '${JSON.stringify({ sessionId: ROW.id, pid: 1, peerProtocol: protocol, kind, procStart: '0' })}' }
      function Get-Process { param($Id) [pscustomobject]@{ ProcessName=${quote(processName)}; StartTime=[datetime]'2026-01-01' } }
      try { & ${quote(helper)} -SessionId ${quote(ROW.id)} -MessageFile ${quote(message)}; throw 'unexpected_success' }
      catch { [Console]::Write($_.Exception.Message) }
    `;
    assert.equal(execFileSync(shell, ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim(), expected);
  }
});

test('X10 a malformed middle row cannot produce a false unique match or no-match', async t => {
  await fixture(t, `${JSON.stringify(ROW)}\n{bad}\n${JSON.stringify(SECOND)}\n`);
  for (const name of ['目标', '不存在']) await assert.rejects(findSessions(null, { codex: name }), { code: 'index_incomplete' });
});

test('X10 unrecognized rows cannot be silently dropped', async t => {
  const { file } = await fixture(t);
  for (const row of [null, [], 7, { ...ROW, id: 'not-a-session-id' }, { id: ROW.id, title: 'renamed schema' }, { ...ROW, updated_at: null }]) {
    await fs.writeFile(file, `${JSON.stringify(ROW)}\n${JSON.stringify(row)}\n`);
    await assert.rejects(findSessions(null, { codex: ROW.thread_name }), { code: 'index_incomplete' });
  }
});

test('X10 a persistent torn final line is reread once and then rejected', async t => {
  const { file } = await fixture(t, `${JSON.stringify(ROW)}\n{"id":`);
  const original = fs.readFile;
  let reads = 0;
  fs.readFile = async (target, ...args) => { if (target === file) reads++; return original(target, ...args); };
  try {
    await assert.rejects(findSessions(null, { codex: ROW.thread_name }), { code: 'index_incomplete' });
    assert.equal(reads, 2);
  } finally { fs.readFile = original; }
});

test('X10 a completed trailing write is reread before deciding uniqueness', async t => {
  const { file } = await fixture(t);
  const original = fs.readFile;
  let reads = 0;
  fs.readFile = async (target, ...args) => target === file
    ? (++reads === 1 ? `${JSON.stringify(ROW)}\n{"id":` : `${JSON.stringify(ROW)}\n${JSON.stringify(SECOND)}`)
    : original(target, ...args);
  try {
    const result = await findSessions(null, { codex: ROW.thread_name });
    assert.equal(reads, 2);
    assert.equal(result.unique, null);
    assert.equal(result.matches.length, 2);
  } finally { fs.readFile = original; }
});

test('X10 complete empty and unmatched indexes differ from unreadable or missing indexes', async t => {
  const { file } = await fixture(t);
  assert.deepEqual((await findSessions(null, { codex: '不存在' })).matches, []);
  await fs.writeFile(file, JSON.stringify(ROW));
  assert.equal((await findSessions(null, { codex: ROW.thread_name })).unique, ROW.id);
  assert.equal((await findSessions(null, { codex: '不存在' })).unique, null);
  const original = fs.readFile;
  fs.readFile = async (target, ...args) => {
    if (target === file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return original(target, ...args);
  };
  try { await assert.rejects(findSessions(null, { codex: ROW.thread_name }), { code: 'index_unreadable' }); }
  finally { fs.readFile = original; }
  await fs.unlink(file);
  await assert.rejects(findSessions(null, { codex: ROW.thread_name }), { code: 'index_not_found' });
});
