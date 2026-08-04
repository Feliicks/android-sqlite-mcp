import Database from 'better-sqlite3';
import { logger } from './logger.js';

export class DatabaseManager {
  /**
   * Helper to open a database connection in readonly mode by default
   */
  private getDb(dbPath: string, readonly = true): Database.Database {
    return new Database(dbPath, { readonly });
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
            const countStmt = db.prepare(`SELECT COUNT(*) as count FROM "${table.name}"`);
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
    // Determine if the query is a write operation
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i.test(query);
    const db = this.getDb(dbPath, !isWrite);

    try {
      const stmt = db.prepare(query);
      if (isWrite) {
        const result = stmt.run(...params);
        return {
          type: 'write',
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid.toString(),
        };
      } else {
        const rows = stmt.all(...params);
        return {
          type: 'read',
          rowCount: rows.length,
          rows,
        };
      }
    } catch (e: any) {
      logger.error({ err: e, query, params }, 'Failed to execute query');
      throw e;
    } finally {
      db.close();
    }
  }
}
