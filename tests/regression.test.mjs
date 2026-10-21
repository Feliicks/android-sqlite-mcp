import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { normalizeArguments, dbName } from '../build/validation.js';
import { databaseOperation, withDatabaseLock } from '../build/operations.js';

const root = fs.mkdtempSync(path.resolve('.regression-'));
process.env.ANDROID_MCP_LOG_DIR = path.join(root, 'logs');
process.env.ANDROID_MCP_CACHE_DIR = path.join(root, 'cache');
const signal = new AbortController().signal;

test('legacy arguments, invalid values and conflicting aliases', () => {
  assert.equal(normalizeArguments('list_databases', { package_name: 'com.example.app' }).appId, 'com.example.app');
  for (const value of [undefined, null, '', 12, '../escape', 'com.app;echo']) {
    assert.throws(() => normalizeArguments('list_databases', { appId: value }), /InvalidParams/);
  }
  assert.throws(() => normalizeArguments('list_databases', { appId: 'com.a.app', package_name: 'com.b.app' }), /conflict/);
  for (const value of ['../db', 'C:\\db', 'db"', 'db|echo', 'NUL.db']) assert.throws(() => dbName(value));
  assert.equal(dbName('my database.db'), 'my database.db');
  assert.throws(() => normalizeArguments('execute_query', { appId: 'com.example.app', dbName: 'a.db', query: 'SELECT ?', params: [true] }));
});

test('SQLite SQL classification, RETURNING, missing DB, limits and cancellation', async () => {
  const file = path.join(root, 'test.db');
  const db = new Database(file); db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)'); db.close();
  const run = query => databaseOperation('executeQuery', [file, query], signal);
  assert.equal((await run("/* comment */ INSERT INTO t(value) VALUES ('a')")).changes, 1);
  assert.deepEqual((await run("INSERT INTO t(value) VALUES ('b') RETURNING value")).rows, [{ value: 'b' }]);
  await run("WITH x AS (SELECT 1) UPDATE t SET value='c' WHERE id IN (SELECT * FROM x)");
  assert.equal((await run('SELECT value FROM t WHERE id=1')).rows[0].value, 'c');
  const limited = await run('WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<1100) SELECT * FROM x');
  assert.equal(limited.rowCount, 1000); assert.equal(limited.truncated, true);
  const missing = path.join(root, 'missing.db');
  await assert.rejects(databaseOperation('executeQuery', [missing, 'CREATE TABLE bad(x)'], signal));
  assert.equal(fs.existsSync(missing), false);
  const controller = new AbortController();
  const running = databaseOperation('executeQuery', [file, 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x'], controller.signal);
  setTimeout(() => controller.abort(), 1000);
  await assert.rejects(running, /Cancelled/);
  assert.equal((await run('SELECT 1 AS ok')).rows[0].ok, 1);
});

test('conflicting operations are rejected and lock released after failure', async () => {
  const file = path.join(root, 'lock.db');
  await withDatabaseLock(file, async () => {
    await assert.rejects(withDatabaseLock(file, async () => 1), /DatabaseBusy/);
  });
  await assert.rejects(withDatabaseLock(file, async () => { throw new Error('failure'); }));
  assert.equal(await withDatabaseLock(file, async () => 42), 42);
});

test('ADB states, stable extraction, failed copy preservation and device isolation', async () => {
  const { AdbManager } = await import('../build/AdbManager.js');
  const manager = new AdbManager();
  const source = path.join(root, 'source.db');
  const db = new Database(source); db.exec('CREATE TABLE sample(x); INSERT INTO sample VALUES(42)'); db.close();
  const bytes = fs.readFileSync(source);
  let devices = 'List of devices attached\nserial1\tdevice\n';
  let changed = false; let copies = 0;
  manager.adb = async args => {
    if (args[0] === 'devices') return Buffer.from(devices);
    const command = args.at(-1);
    if (command.includes('-wal')) throw new Error('No such file or directory');
    if (command.includes('cat')) { copies++; return changed && copies % 2 === 0 ? Buffer.from('changed') : bytes; }
    return Buffer.from('');
  };
  const previous = process.env.ANDROID_SERIAL; delete process.env.ANDROID_SERIAL;
  const file = path.join(root, 'pulled.db'); const paths = { main: file, wal: file + '-wal', shm: file + '-shm' };
  try {
    for (const state of ['', 'serial1\toffline\n', 'serial1\tunauthorized\n', 'serial1\tdevice\nserial2\tdevice\n']) {
      devices = 'List of devices attached\n' + state;
      await assert.rejects(manager.listPackages(), /DeviceUnavailable|MultipleDevices/);
    }
    devices = 'List of devices attached\nserial1\tdevice\n';
    await manager.pullDatabase('com.example.app', 'my database.db', paths);
    const before = fs.readFileSync(file);
    changed = true; copies = 0;
    await assert.rejects(manager.pullDatabase('com.example.app', 'my database.db', paths), /DatabaseBusy/);
    assert.deepEqual(fs.readFileSync(file), before);
    changed = false;
    fs.writeFileSync(paths.wal, 'stale');
    await assert.rejects(manager.pullDatabase('com.example.app', 'my database.db', paths), /CacheConflict/);
    assert.deepEqual(fs.readFileSync(file), before); fs.unlinkSync(paths.wal);
    devices = 'List of devices attached\nserial2\tdevice\n';
    await assert.rejects(manager.pullDatabase('com.example.app', 'my database.db', paths), /another device/);
  } finally { if (previous === undefined) delete process.env.ANDROID_SERIAL; else process.env.ANDROID_SERIAL = previous; }
});

test('MCP survives invalid calls, stdout is protocol only and EOF exits', async () => {
  const child = spawn(process.execPath, ['build/index.js'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const waitFor = async id => {
    for (let n = 0; n < 400; n++) {
      const result = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.id === id);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('No MCP response: ' + errors);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'regression', version: '1' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_databases', arguments: {} } });
    assert.equal((await waitFor(2)).result.isError, true);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_cache_status', arguments: {} } });
    assert.equal((await waitFor(3)).result.isError, undefined);
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('EOF did not shut down')), 3000); t.unref(); })]);
    assert.equal(code, 0);
  } finally { child.kill(); }
});

test('WAL contents are recovered into a standalone validated snapshot', async () => {
  const { AdbManager } = await import('../build/AdbManager.js');
  const source = path.join(root, 'wal-source.db');
  const db = new Database(source);
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE wal_data(x); INSERT INTO wal_data VALUES(99)');
  const manager = new AdbManager();
  manager.adb = async args => {
    if (args[0] === 'devices') return Buffer.from('List of devices attached\nwal-device\tdevice\n');
    return fs.readFileSync(source + (args.at(-1).includes('-wal') ? '-wal' : ''));
  };
  const file = path.join(root, 'wal-pulled.db');
  try {
    await manager.pullDatabase('com.example.app', 'wal.db', { main: file, wal: file + '-wal', shm: file + '-shm' });
    const recovered = new Database(file, { readonly: true });
    try { assert.equal(recovered.prepare('SELECT x FROM wal_data').get().x, 99); }
    finally { recovered.close(); }
    assert.equal(fs.existsSync(file + '-wal'), false);
    assert.equal(fs.existsSync(file + '-shm'), false);
  } finally { db.close(); }
});

test('SQLite timeout releases child process and permits another query', async () => {
  const file = path.join(root, 'test.db');
  await assert.rejects(databaseOperation('executeQuery', [file, 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x'], signal), /QueryTimeout/);
  assert.equal((await databaseOperation('executeQuery', [file, 'SELECT 1 AS ok'], signal)).rows[0].ok, 1);
});

test('closed output pipe exits without an uncaught EPIPE', async () => {
  const child = spawn(process.execPath, ['build/index.js'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdout.destroy();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'closed-pipe', version: '1' } } }) + '\n');
  try {
    const code = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('closed pipe did not exit')), 10000); timer.unref(); })]);
    assert.equal(code, 0); assert.doesNotMatch(errors, /Uncaught|EPIPE/);
  } finally { child.kill(); }
});

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
