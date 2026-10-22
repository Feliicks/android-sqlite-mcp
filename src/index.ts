#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CacheManager } from "./CacheManager.js";
import { AdbManager } from "./AdbManager.js";
import { normalizeArguments } from "./validation.js";
import { databaseOperation, withDatabaseLock } from "./operations.js";
import { logger } from "./logger.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const shutdownController = new AbortController();
let shuttingDown = false;
async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'SERVER_SHUTDOWN');
  shutdownController.abort();
  adbManager.cancel();
  const timer = setTimeout(() => process.exit(code), 1000);
  timer.unref();
  try { await server.close(); } catch {}
  process.exitCode = code;
}
const cacheManager = new CacheManager();
const adbManager = new AdbManager();


// Initialize the MCP Server
const server = new Server(
  {
    name: "android-sqlite-mcp",
    version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

process.stdout.on('error', error => { void shutdown(error.message, (error as NodeJS.ErrnoException).code === 'EPIPE' ? 0 : 1); });
process.stdin.on('end', () => { void shutdown('stdin ended'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('uncaughtException', error => { logger.fatal({ err: error }, 'Uncaught exception'); void shutdown(error.message, 1); });
process.on('unhandledRejection', reason => { logger.fatal({ reason }, 'Unhandled rejection'); void shutdown('unhandled rejection', 1); });

// Register Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_packages",
        description: "Lists installed Android application packages on the device, optionally filtered by a query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional filter string (e.g. 'com.example')" },
          },
        },
      },
      {
        name: "list_databases",
        description: "Lists all SQLite database files available in the internal storage of a specific Android app on the connected device.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "The Android package name (e.g. com.example.app). Legacy package_name calls are also accepted." },
          },
          required: ["appId"],
        },
      },
      {
        name: "pull_database",
        description: "Extracts an SQLite database and its WAL files from an Android device into the local cache using adb run-as.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "The Android package name (e.g. com.example.app)" },
            dbName: { type: "string", description: "The name of the database file (e.g. app_database.db)" },
          },
          required: ["appId", "dbName"],
        },
      },
      {
        name: "get_cache_status",
        description: "Returns information about the currently cached Android SQLite databases ready to be queried.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_tables",
        description: "Lists tables and views in a cached database with row counts (15 second timeout).",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "The Android package name" },
            dbName: { type: "string", description: "The name of the database file" },
          },
          required: ["appId", "dbName"],
        },
      },
      {
        name: "get_schema",
        description: "Returns the DDL schema (CREATE TABLE) for a specific table in a cached database.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "The Android package name" },
            dbName: { type: "string", description: "The name of the database file" },
            tableName: { type: "string", description: "The name of the table or view to inspect" },
          },
          required: ["appId", "dbName", "tableName"],
        },
      },
      {
        name: "execute_query",
        description: "Executes SQL on the local cached database only. Results limited to 1000 rows / 1 MiB, timeout 15 seconds. Writes do not update Android.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "The Android package name" },
            dbName: { type: "string", description: "The name of the database file" },
            query: { type: "string", description: "The raw SQL query to execute" },
            params: { 
              type: "array", 
              description: "Optional array of parameters for the query (e.g. [1, 'test'])",
              items: {}
            },
          },
          required: ["appId", "dbName", "query"],
        },
      },
    ],
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: input } = request.params;
  const signal = AbortSignal.any([extra.signal, shutdownController.signal]);
  let args: Record<string, any> = {};

  try {
    signal.throwIfAborted();
    args = normalizeArguments(name, input);
    switch (name) {
      case "list_packages": {
        const query = args?.query as string | undefined;
        const packages = await adbManager.listPackages(query, signal);
        return {
          content: [
            {
              type: "text",
              text: packages.length > 0 
                ? `Packages found:\n${packages.join('\n')}` 
                : `No packages found matching query '${query}'`,
            },
          ],
        };
      }

      case "list_databases": {
        const { appId } = args as { appId: string };
        const databases = await adbManager.listDatabases(appId, signal);
        return {
          content: [
            {
              type: "text",
              text: databases.length > 0 
                ? `Databases found for ${appId}:\n${databases.join('\n')}` 
                : `No databases found for ${appId}`,
            },
          ],
        };
      }

      case "pull_database": {
        const { appId, dbName } = args as { appId: string; dbName: string };
        const paths = cacheManager.getDbPaths(appId, dbName);
        const result = await withDatabaseLock(paths.main, () => adbManager.pullDatabase(appId, dbName, paths, signal));
        return {
          content: [
            {
              type: "text",
              text: `Database pulled successfully.\nMain DB: ${result.main}\nWAL: ${result.wal}\nSHM: ${result.shm}\nSaved to: ${paths.main}`,
            },
          ],
        };
      }

      case "get_cache_status": {
        const status = cacheManager.getCacheStatus();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      case "list_tables": {
        const { appId, dbName } = args as { appId: string; dbName: string };
        const paths = cacheManager.getDbPaths(appId, dbName);
        const tables = await withDatabaseLock(paths.main, () => databaseOperation('listTables', [paths.main], signal));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(tables, null, 2),
            },
          ],
        };
      }

      case "get_schema": {
        const { appId, dbName, tableName } = args as { appId: string; dbName: string; tableName: string };
        const paths = cacheManager.getDbPaths(appId, dbName);
        const schema = await withDatabaseLock(paths.main, () => databaseOperation('getSchema', [paths.main, tableName], signal));
        return {
          content: [
            {
              type: "text",
              text: schema,
            },
          ],
        };
      }

      case "execute_query": {
        const { appId, dbName, query, params } = args as { appId: string; dbName: string; query: string; params?: any[] };
        const paths = cacheManager.getDbPaths(appId, dbName);
        const result = await withDatabaseLock(paths.main, () => databaseOperation('executeQuery', [paths.main, query, params ?? []], signal));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    logger.error({ err: error, tool: name }, `Error executing tool ${name}`);
    return {
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the Server
async function main() {
  const transport = new StdioServerTransport();
  server.onclose = () => { void shutdown('transport closed'); };
  server.onerror = error => logger.error({ err: error }, 'Transport error');
  await server.connect(transport);
  logger.info("Android SQLite MCP Server running on stdio");
}

main().catch((error) => {
  logger.fatal({ err: error }, "Fatal startup error");
  process.exit(1);
});
