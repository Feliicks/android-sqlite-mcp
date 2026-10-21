import pino from 'pino';
import path from 'path';
import os from 'os';
import fs from 'fs';

const logDir = process.env.ANDROID_MCP_LOG_DIR || path.join(os.homedir(), '.android-sqlite-mcp', 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

export const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-roll',
    options: {
      file: path.join(logDir, 'server'),
      size: '5m',
      extension: '.log',
      mkdir: true,
      sync: false,
      limit: {
        count: 3
      }
    }
  }
});
