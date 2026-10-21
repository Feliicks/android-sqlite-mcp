import fs from 'fs';
import path from 'path';
import os from 'os';
import { appId as validateAppId, dbName as validateDbName } from './validation.js';

export interface CacheEntry {
  appId: string;
  dbName: string;
  files: {
    main: { path: string; size: number; mtime: Date } | null;
    wal: { path: string; size: number; mtime: Date } | null;
    shm: { path: string; size: number; mtime: Date } | null;
  };
  lastExtracted: Date | null;
}

export class CacheManager {
  private cacheDir: string;

  constructor() {
    this.cacheDir =
      process.env.ANDROID_MCP_CACHE_DIR ||
      path.join(os.homedir(), '.android-sqlite-mcp', 'cache');

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Retrieves the directory for a specific app's cached databases.
   */
  public getAppCacheDir(appId: string): string {
    const appDir = path.join(this.cacheDir, validateAppId(appId));
    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }
    if (fs.lstatSync(appDir).isSymbolicLink()) throw new Error('InvalidCache: application directory must not be a symlink');
    return appDir;
  }

  /**
   * Retrieves the paths for a specific database and its WAL files.
   */
  public getDbPaths(appId: string, dbName: string) {
    dbName = validateDbName(dbName);
    const appDir = this.getAppCacheDir(appId);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = path.join(appDir, dbName + suffix);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('InvalidCache: database must not be a symlink');
    }
    return {
      main: path.join(appDir, dbName),
      wal: path.join(appDir, `${dbName}-wal`),
      shm: path.join(appDir, `${dbName}-shm`),
    };
  }

  /**
   * Retrieves the status of all cached databases.
   */
  public getCacheStatus(): CacheEntry[] {
    const entries: CacheEntry[] = [];
    if (!fs.existsSync(this.cacheDir)) return entries;

    const apps = fs.readdirSync(this.cacheDir, { withFileTypes: true });

    for (const app of apps) {
      if (!app.isDirectory()) continue;
      try { validateAppId(app.name); } catch { continue; }
      const appId = app.name;
      const appDir = path.join(this.cacheDir, validateAppId(appId));
      const files = fs.readdirSync(appDir);

      // Group files by base DB name
      const dbNames = new Set<string>();
      for (const file of files) {
        if (file.startsWith('.') || file.endsWith('.mcp-lock') || file.endsWith('.mcp-device') || !fs.lstatSync(path.join(appDir, file)).isFile()) continue;
        if (file.endsWith('-wal')) dbNames.add(file.replace('-wal', ''));
        else if (file.endsWith('-shm')) dbNames.add(file.replace('-shm', ''));
        else dbNames.add(file);
      }

      for (const dbName of dbNames) {
        try { validateDbName(dbName); } catch { continue; }
        const paths = this.getDbPaths(appId, dbName);
        
        const mainStats = fs.existsSync(paths.main) ? fs.statSync(paths.main) : null;
        const walStats = fs.existsSync(paths.wal) ? fs.statSync(paths.wal) : null;
        const shmStats = fs.existsSync(paths.shm) ? fs.statSync(paths.shm) : null;

        let lastExtracted = null;
        if (mainStats) lastExtracted = mainStats.mtime;
        if (walStats && (!lastExtracted || walStats.mtime > lastExtracted)) lastExtracted = walStats.mtime;

        entries.push({
          appId,
          dbName,
          files: {
            main: mainStats ? { path: paths.main, size: mainStats.size, mtime: mainStats.mtime } : null,
            wal: walStats ? { path: paths.wal, size: walStats.size, mtime: walStats.mtime } : null,
            shm: shmStats ? { path: paths.shm, size: shmStats.size, mtime: shmStats.mtime } : null,
          },
          lastExtracted,
        });
      }
    }

    return entries;
  }
}
