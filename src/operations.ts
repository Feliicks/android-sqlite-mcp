import fs from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function withDatabaseLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.mcp-lock`;
  let fd: number;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error: any) {
    if (error.code === 'EEXIST') throw new Error('DatabaseBusy: another operation holds the cache lock');
    throw error;
  }
  try { fs.writeSync(fd, String(process.pid)); return await action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export function databaseOperation(method: string, args: unknown[], signal: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    const options = { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true } as import('node:child_process').ForkOptions & { windowsHide: boolean };
    const worker = fork(fileURLToPath(new URL('./databaseWorker.js', import.meta.url)), [], options);
    let finished = false;
    const finish = async (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
        worker.kill('SIGKILL');
        await exited;
      }
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { void finish(new Error('Cancelled')); };
    const timer = setTimeout(() => { void finish(new Error('QueryTimeout: exceeded 15 seconds')); }, 15000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('message', message => {
      const result = message as { error?: string; value?: unknown };
      void finish(result.error ? new Error(result.error) : undefined, result.value);
    });
    worker.once('error', error => { void finish(error instanceof Error ? error : new Error(String(error))); });
    worker.once('exit', code => { if (!finished) void finish(new Error(`Database worker exited (${code})`)); });
    worker.send({ method, args }, error => { if (error) void finish(error); });
  });
}
