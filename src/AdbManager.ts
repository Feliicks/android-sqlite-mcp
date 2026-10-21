import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { databaseOperation } from './operations.js';
import { appId as validateAppId, dbName as validateDbName } from './validation.js';
const execute = promisify(execFile);
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export class AdbManager {
  private active = new AbortController();
  cancel() { this.active.abort(); }
  private async adb(args: string[], signal?: AbortSignal): Promise<Buffer> {
    try {
      const { stdout } = await execute('adb', args, { encoding: 'buffer', timeout: 15000, maxBuffer: 128 * 1024 * 1024, windowsHide: true, signal: AbortSignal.any([this.active.signal, ...(signal ? [signal] : [])]) });
      return stdout;
    } catch (error: any) {
      const message = error.message ?? String(error);
      const code = /offline/i.test(message) ? 'DeviceOffline' : /unauthorized/i.test(message) ? 'DeviceUnauthorized' : /more than one/i.test(message) ? 'MultipleDevices' : /no devices|ENOENT/i.test(message) ? 'DeviceUnavailable' : error.killed ? 'ADBTimeout' : 'ADBError';
      throw new Error(code + ': ' + message);
    }
  }
  private async device(signal?: AbortSignal): Promise<string[]> {
    const output = (await this.adb(['devices'], signal)).toString();
    const devices = output.split(/\r?\n/).map(line => line.match(/^(\S+)\s+(device|offline|unauthorized)\b/)).filter(Boolean) as RegExpMatchArray[];
    const selected = process.env.ANDROID_SERIAL;
    if (!selected && devices.length > 1) throw new Error('MultipleDevices: set ANDROID_SERIAL to select a device');
    const device = selected ? devices.find(d => d[1] === selected) : devices[0];
    if (!device) throw new Error('DeviceUnavailable: no selected Android device connected');
    if (device[2] !== 'device') throw new Error('DeviceUnavailable: ' + device[1] + ' is ' + device[2]);
    return ['-s', device[1]];
  }
  async listPackages(query?: string, signal?: AbortSignal): Promise<string[]> {
    if (query !== undefined && typeof query !== 'string') throw new Error('InvalidParams: query must be a string');
    const target = await this.device(signal);
    return (await this.adb([...target, 'shell', 'pm list packages'], signal)).toString().split(/\r?\n/).filter(line => line.startsWith('package:')).map(line => line.slice(8).trim()).filter(pkg => !query || pkg.toLowerCase().includes(query.toLowerCase()));
  }
  async listDatabases(appId: string, signal?: AbortSignal): Promise<string[]> {
    appId = validateAppId(appId);
    const target = await this.device(signal);
    try {
      const output = (await this.adb([...target, 'shell', 'run-as ' + quote(appId) + ' ls -1 databases'], signal)).toString();
      return output.split(/\r?\n/).filter(file => file && !/-(wal|shm|journal)$/.test(file));
    } catch (error: any) { if (error.message.includes('No such file or directory')) return []; throw error; }
  }
  async pullDatabase(appId: string, dbName: string, paths: { main: string; wal: string; shm: string }, signal?: AbortSignal) {
    appId = validateAppId(appId); dbName = validateDbName(dbName);
    const target = await this.device(signal);
    const identity = paths.main + '.mcp-device';
    if (fs.existsSync(identity) && fs.readFileSync(identity, 'utf8') !== target[1]) throw new Error('CacheConflict: cached database belongs to another device; use a different ANDROID_MCP_CACHE_DIR');
    const temp = fs.mkdtempSync(path.join(path.dirname(paths.main), '.extract-'));
    const read = async (suffix: string): Promise<Buffer | null> => {
      try { return await this.adb([...target, 'exec-out', 'run-as ' + quote(appId) + ' cat ' + quote('databases/' + dbName + suffix)], signal); }
      catch (error: any) { if (suffix && error.message.includes('No such file or directory')) return null; throw error; }
    };
    try {
      const main = await read(''); const wal = await read('-wal');
      const again = await read(''); const walAgain = await read('-wal');
      if (!main?.length || !again?.equals(main) || (wal === null ? walAgain !== null : !walAgain?.equals(wal))) throw new Error('DatabaseBusy: database changed during extraction; stop app writes and retry');
      const staged = path.join(temp, 'snapshot.db');
      fs.writeFileSync(staged, main);
      if (wal?.length) fs.writeFileSync(staged + '-wal', wal);
      await databaseOperation('prepareSnapshot', [staged], AbortSignal.any([this.active.signal, ...(signal ? [signal] : [])]));
      signal?.throwIfAborted(); this.active.signal.throwIfAborted();
      // Existing sidecars are removed while the per-database process lock is held.
      for (const sidecar of [paths.wal, paths.shm, paths.main + '-journal']) {
        if (fs.existsSync(sidecar)) throw new Error('CacheConflict: existing SQLite sidecars; close other readers and clear this cached database before extracting again');
      }
      fs.renameSync(staged, paths.main);
      fs.writeFileSync(identity, target[1]);
      return { main: true, wal: !!wal?.length, shm: false };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}
