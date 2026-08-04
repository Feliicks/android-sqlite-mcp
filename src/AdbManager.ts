import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export class AdbManager {
  /**
   * Helper to execute adb commands and return stdout.
   */
  private async executeAdb(command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`adb ${command}`, { encoding: 'buffer' });
      return stdout.toString('utf-8').trim();
    } catch (error: any) {
      throw new Error(`ADB Error: ${error.message}`);
    }
  }

  /**
   * Pulls a file from the app's internal databases directory using run-as and exec-out.
   * We use exec-out to avoid \r\n corruption on binary files.
   */
  private async pullFile(appId: string, remoteFileName: string, localPath: string): Promise<boolean> {
    try {
      // Check if file exists first to avoid creating empty corrupted files
      const checkCmd = `adb shell "run-as ${appId} ls databases/${remoteFileName}"`;
      try {
        await execAsync(checkCmd);
      } catch (e) {
        // File does not exist
        return false;
      }

      // Pull the binary file safely using exec-out
      const pullCmd = `adb exec-out "run-as ${appId} cat databases/${remoteFileName}" > "${localPath}"`;
      await execAsync(pullCmd, { encoding: 'buffer' });
      
      // Verify the file was written and is not completely empty (unless it was legitimately empty, but DB files aren't)
      const stats = fs.statSync(localPath);
      if (stats.size === 0) {
        fs.unlinkSync(localPath);
        return false;
      }
      return true;
    } catch (error: any) {
      logger.warn({ err: error, appId, remoteFileName }, `Failed to pull ${remoteFileName}`);
      return false;
    }
  }

  /**
   * Pulls the database and its WAL files to the local cache.
   */
  public async pullDatabase(
    appId: string,
    dbName: string,
    paths: { main: string; wal: string; shm: string }
  ): Promise<{ main: boolean; wal: boolean; shm: boolean }> {
    const mainSuccess = await this.pullFile(appId, dbName, paths.main);
    
    if (!mainSuccess) {
      throw new Error(`Failed to extract main database file: ${dbName} from app: ${appId}. Are you sure the app is debuggable and the database exists?`);
    }

    // Attempt to pull WAL and SHM, but don't fail if they don't exist
    const walSuccess = await this.pullFile(appId, `${dbName}-wal`, paths.wal);
    const shmSuccess = await this.pullFile(appId, `${dbName}-shm`, paths.shm);

    return {
      main: mainSuccess,
      wal: walSuccess,
      shm: shmSuccess,
    };
  }

  /**
   * Lists all available database files for a specific application.
   */
  public async listDatabases(appId: string): Promise<string[]> {
    try {
      const cmd = `adb shell "run-as ${appId} ls databases"`;
      const output = await this.executeAdb(`shell "run-as ${appId} ls databases"`);
      
      // Parse output: split by whitespace, filter out WAL, SHM, and system files like journal
      const files = output.split(/\s+/).filter(file => file.trim().length > 0);
      
      const dbNames = new Set<string>();
      for (const file of files) {
        if (file.endsWith('-wal')) dbNames.add(file.replace('-wal', ''));
        else if (file.endsWith('-shm')) dbNames.add(file.replace('-shm', ''));
        else if (!file.endsWith('-journal')) dbNames.add(file);
      }
      
      return Array.from(dbNames);
    } catch (error: any) {
      // If the directory doesn't exist or app doesn't have databases
      if (error.message.includes('No such file or directory')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Lists installed application packages, optionally filtered by a query string.
   */
  public async listPackages(query?: string): Promise<string[]> {
    try {
      const output = await this.executeAdb(`shell pm list packages`);
      
      const packages = output
        .split('\n')
        .map(line => line.trim().replace('package:', ''))
        .filter(pkg => pkg.length > 0);

      if (query) {
        const lowerQuery = query.toLowerCase();
        return packages.filter(pkg => pkg.toLowerCase().includes(lowerQuery));
      }
      
      return packages;
    } catch (error: any) {
      throw error;
    }
  }
}
