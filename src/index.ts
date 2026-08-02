#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CacheManager } from "./CacheManager.js";
import { AdbManager } from "./AdbManager.js";
import { DatabaseManager } from "./DatabaseManager.js";

const cacheManager = new CacheManager();
const adbManager = new AdbManager();
const databaseManager = new DatabaseManager();

// Initialize the MCP Server
const server = new Server(
  {
    name: "android-sqlite-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

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
            appId: { type: "string", description: "The Android package name (e.g. com.example.app)" },
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
        description: "Lists all tables and views in a cached database along with their approximate row counts.",
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
        description: "Executes a raw SQL query on a cached database. Can be used for SELECT or write operations (INSERT/UPDATE/DELETE).",
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_packages": {
        const query = args?.query as string | undefined;
        const packages = await adbManager.listPackages(query);
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
        const databases = await adbManager.listDatabases(appId);
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
        const result = await adbManager.pullDatabase(appId, dbName, paths);
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
        const tables = databaseManager.listTables(paths.main);
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
        const schema = databaseManager.getSchema(paths.main, tableName);
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
        const result = databaseManager.executeQuery(paths.main, query, params || []);
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
  await server.connect(transport);
  console.error("Android SQLite MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
