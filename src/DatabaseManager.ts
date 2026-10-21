import Database from 'better-sqlite3';
import { logger } from './logger.js';

export class DatabaseManager {
  public prepareSnapshot(dbPath: string) {
    const db = this.getDb(dbPath, false);
    try {
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('InvalidDatabase: integrity check failed');
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (checkpoint.some(row => row.busy)) throw new Error('DatabaseBusy: snapshot checkpoint failed');
      db.pragma('journal_mode = DELETE');
    } finally { db.close(); }
    return true;
  }
  /**
   * Helper to open a database connection in readonly mode by default
   */
  private getDb(dbPath: string, readonly = true): Database.Database {
    return new Database(dbPath, { readonly, fileMustExist: true, timeout: 1000 });
  }

  /**
   * Retrieves a list of tables and views with an approximate row count.
   */
  public listTables(dbPath: string) {
    const db = this.getDb(dbPath);
    try {
      const stmt = db.prepare(`
        SELECT name, type 
        FROM sqlite_master 
        WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      const tables = stmt.all() as { name: string; type: string }[];

      // Fetch row counts
      const result = tables.map((table) => {
        let rowCount = 0;
        if (table.type === 'table') {
          try {
            const countStmt = db.prepare(`SELECT COUNT(*) as count FROM "${table.name.replace(/"/g, '""')}"`);
            const row = countStmt.get() as { count: number };
            rowCount = row.count;
          } catch (e: any) {
            logger.warn({ err: e, table: table.name }, 'Failed to count rows');
          }
        }
        return {
          name: table.name,
          type: table.type,
          rowCount,
        };
      });

      return result;
    } finally {
      db.close();
    }
  }

  /**
   * Retrieves the DDL schema for a specific table or view.
   */
  public getSchema(dbPath: string, tableName: string) {
    const db = this.getDb(dbPath);
    try {
      const stmt = db.prepare(`
        SELECT sql 
        FROM sqlite_master 
        WHERE type IN ('table', 'view') AND name = ?
      `);
      const result = stmt.get(tableName) as { sql: string } | undefined;
      
      if (!result) {
        throw new Error(`Table or view '${tableName}' not found in the database.`);
      }

      return result.sql;
    } finally {
      db.close();
    }
  }

  /**
   * Executes a raw SQL query.
   * If the query modifies data, it will be executed using run() and will return changes/lastInsertRowid.
   * If it's a SELECT, it will return the rows.
   */
  public executeQuery(dbPath: string, query: string, params: any[] = []) {
    // SQLite classifies statements (including CTEs, comments and RETURNING).
    const db = this.getDb(dbPath, false);

    try {
      const stmt = db.prepare(query);
      if (!stmt.reader) {
        const result = stmt.run(...params);
        return {
          type: 'write',
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid.toString(),
        };
      } else {
        const rows: unknown[] = [];
        let truncated = false;
        let bytes = 0;
        for (const row of stmt.iterate(...params)) {
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (rows.length >= 1000 || bytes > 1024 * 1024) { truncated = true; break; }
          rows.push(row);
        }
        return {
          type: 'read',
          truncated,
          rowCount: rows.length,
          rows,
        };
      }
    } catch (e: any) {
      logger.error({ err: e }, 'Failed to execute query');
      throw e;
    } finally {
      db.close();
    }
  }
}
