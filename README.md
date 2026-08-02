# Android SQLite MCP Server

A Model Context Protocol (MCP) server to connect AI agents directly to the embedded SQLite/Room databases of your Android applications.

## What problem does this solve?
Accessing embedded databases (SQLite, Room, SQLDelight) on Android devices during development has historically been a cumbersome process. It requires running `adb shell run-as` commands, manually copying files, dealing with `.db-wal` (Write-Ahead Logging) files to prevent data loss, and then using external SQL clients to read the information.

**This MCP server automates the entire process.** It allows any AI agent (like Claude, Cursor, or Antigravity) to inspect tables, read schemas, and execute live SQL queries (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) on your application's database, right from the chat window.

## Features

- 📥 **Secure Extraction:** Uses `adb exec-out run-as` to safely extract data without corruption and without requiring root access.
- 🗄️ **Smart Caching:** Stores local copies organized in `~/.android-sqlite-mcp/cache/`.
- 🔍 **Search and Inspection:** Tools to search installed packages, list databases, view tables, and retrieve full DDL schemas.
- ⚡ **Queries (CRUD):** Executes raw SQL queries locally and returns the results in JSON format to the AI.

## Technical Prerequisites

1. **Node.js**: Version 18 or higher.
2. **Android Debug Bridge (ADB)**: Must be installed and configured in your system's `PATH` (verify with `adb version`).
3. **Device/Emulator**: A device or emulator must be connected (`adb devices`).
4. **Debuggable App**: The Android app must be compiled in debug mode (`android:debuggable="true"`).

## Getting Started (Standard Configuration)

There is no need to manually download or build this repository. You can run the server on the fly using `npx`.

The standard format to register an MCP server in any client is the following:

```json
{
  "mcpServers": {
    "android-sqlite": {
      "command": "npx",
      "args": ["-y", "android-sqlite-mcp"]
    }
  }
}
```

## AI Client Installation Guides

<details>
<summary><b>1. Antigravity</b></summary>
<br>
Add the server by editing the <code>mcp_settings.json</code> file in your global directory (e.g., <code>~/.gemini/antigravity/mcp_settings.json</code>):

```json
{
  "mcpServers": {
    "android-sqlite": {
      "command": "npx",
      "args": ["-y", "android-sqlite-mcp"]
    }
  }
}
```
</details>

<details>
<summary><b>2. Claude Code (CLI)</b></summary>
<br>
If you are using Anthropic's official terminal tool, you can register the server directly with this command:

```bash
claude mcp add android-sqlite npx -y android-sqlite-mcp
```
</details>

<details>
<summary><b>3. Cursor IDE</b></summary>
<br>
In Cursor, MCPs are configured via the graphical interface:

1. Go to **Cursor Settings > Features > MCP**.
2. Click on **"+ Add New MCP Server"**.
3. Fill in the details:
   - **Type:** `command`
   - **Name:** `android-sqlite`
   - **Command:** `npx -y android-sqlite-mcp`
4. Save and verify that the indicator changes to "Connected" (green).
</details>

<details>
<summary><b>4. Claude Desktop</b></summary>
<br>
Edit your configuration file (located at <code>~/.config/Claude/claude_desktop_config.json</code> on macOS/Linux or <code>%APPDATA%\Claude\claude_desktop_config.json</code> on Windows) and add the JSON block from the <i>Getting Started</i> section. Remember to restart the application after saving the changes.
</details>
