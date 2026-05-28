/**
 * Debug logger for CodeGraph MCP Server.
 *
 * Writes timestamped log lines to ~/.codegraph/logs/mcp-debug.log.
 * Used to trace the stats collection and initialization flow.
 *
 * Enable by setting env CODEGRAPH_DEBUG=1 or always-on for key events.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_DIR = join(homedir(), '.codegraph', 'logs');
const LOG_FILE = join(LOG_DIR, 'mcp-debug.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — rotate when exceeded

let initialized = false;

function ensureLogDir(): void {
  if (initialized) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    initialized = true;
  } catch {
    // If we can't create the log dir, logging is disabled
  }
}

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE.
 */
function rotateIfNeeded(): void {
  try {
    const { statSync, renameSync } = require('fs');
    if (existsSync(LOG_FILE)) {
      const stat = statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const backupPath = LOG_FILE + '.1';
        try { renameSync(LOG_FILE, backupPath); } catch { /* overwrite next time */ }
      }
    }
  } catch { /* ignore */ }
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Write a debug log line with timestamp, level, and category tag.
 */
export function debugLog(category: string, message: string, data?: Record<string, unknown>, level: LogLevel = 'INFO'): void {
  ensureLogDir();
  if (!initialized) return;

  const now = new Date();
  const ts = now.toISOString();
  const pid = process.pid;
  let line = `[${ts}] [PID:${pid}] [${level}] [${category}] ${message}`;
  if (data) {
    line += ' ' + JSON.stringify(data);
  }
  line += '\n';

  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // Logging must never break the server
  }
}

/**
 * Shorthand for ERROR level logging.
 */
export function debugError(category: string, message: string, data?: Record<string, unknown>): void {
  debugLog(category, message, data, 'ERROR');
}

/**
 * Shorthand for WARN level logging.
 */
export function debugWarn(category: string, message: string, data?: Record<string, unknown>): void {
  debugLog(category, message, data, 'WARN');
}

/**
 * Log a separator line (for session start).
 */
export function debugLogSessionStart(): void {
  ensureLogDir();
  if (!initialized) return;
  const sep = `\n${'='.repeat(80)}\n[${new Date().toISOString()}] [PID:${process.pid}] === MCP Server Session Start ===\n${'='.repeat(80)}\n`;
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, sep, 'utf8');
  } catch { /* ignore */ }
}
