/**
 * Document Indexer
 *
 * Scans project files, applies exclusion rules, chunks documents,
 * and stores them in SQLite for full-text search.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SqliteDatabase } from '../db';
import { isDocExcluded, isDocFile } from './excludes';
import { chunkMarkdown, chunkPlainText, DocChunk } from './chunker';

export interface DocIndexResult {
  filesIndexed: number;
  chunksCreated: number;
  filesSkipped: number;
  durationMs: number;
}

export interface DocSyncResult {
  filesUpdated: number;
  filesAdded: number;
  filesRemoved: number;
  chunksTotal: number;
}

export interface DocStatus {
  fileCount: number;
  chunkCount: number;
  lastUpdatedAt: number | null;
}

export class DocumentIndexer {
  private db: SqliteDatabase;
  private projectRoot: string;

  constructor(db: SqliteDatabase, projectRoot: string) {
    this.db = db;
    this.projectRoot = projectRoot;
  }

  /**
   * Initialize the document schema (create tables if not exist).
   */
  initSchema(): void {
    const schemaPath = path.join(__dirname, '..', 'db', 'doc-schema.sql');
    // Try dist path first, then src path (for development)
    let schema: string;
    if (fs.existsSync(schemaPath)) {
      schema = fs.readFileSync(schemaPath, 'utf-8');
    } else {
      // Fallback: look relative to current file's location in dist/
      const altPath = path.join(__dirname, '..', '..', 'db', 'doc-schema.sql');
      if (fs.existsSync(altPath)) {
        schema = fs.readFileSync(altPath, 'utf-8');
      } else {
        throw new Error(`doc-schema.sql not found at ${schemaPath} or ${altPath}`);
      }
    }
    this.db.exec(schema);
  }

  /**
   * Full index: scan all doc files, chunk, and insert into DB.
   * Clears existing data first.
   */
  indexAll(): DocIndexResult {
    const start = performance.now();
    let filesIndexed = 0;
    let chunksCreated = 0;
    let filesSkipped = 0;

    // Clear existing document data
    this.db.exec('DELETE FROM doc_chunks');

    // Scan files
    const docFiles = this.scanDocFiles();

    // Process in a transaction for performance
    this.db.exec('BEGIN');
    try {
      const insertStmt = this.db.prepare(
        `INSERT INTO doc_chunks (path, chunk_index, title, heading_level, content, start_line, end_line, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const filePath of docFiles) {
        const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const contentHash = this.hashContent(content);
          const chunks = this.chunkFile(relativePath, content);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            insertStmt.run(
              relativePath,
              i,
              chunk.title,
              chunk.headingLevel,
              chunk.content,
              chunk.startLine,
              chunk.endLine,
              contentHash,
              Date.now()
            );
            chunksCreated++;
          }
          filesIndexed++;
        } catch {
          filesSkipped++;
        }
      }

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    return {
      filesIndexed,
      chunksCreated,
      filesSkipped,
      durationMs: Math.round(performance.now() - start),
    };
  }

  /**
   * Incremental sync: only update files that have changed.
   */
  sync(): DocSyncResult {
    let filesUpdated = 0;
    let filesAdded = 0;
    let filesRemoved = 0;

    // Get current state from DB
    const existingFiles = new Map<string, string>(); // path -> content_hash
    const rows = this.db.prepare(
      'SELECT DISTINCT path, content_hash FROM doc_chunks'
    ).all() as Array<{ path: string; content_hash: string }>;
    for (const row of rows) {
      existingFiles.set(row.path, row.content_hash);
    }

    // Scan current doc files
    const currentFiles = new Map<string, string>(); // path -> content_hash
    const docFiles = this.scanDocFiles();
    for (const filePath of docFiles) {
      const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const contentHash = this.hashContent(content);
        currentFiles.set(relativePath, contentHash);
      } catch {
        // Skip unreadable files
      }
    }

    this.db.exec('BEGIN');
    try {
      const deleteStmt = this.db.prepare('DELETE FROM doc_chunks WHERE path = ?');
      const insertStmt = this.db.prepare(
        `INSERT INTO doc_chunks (path, chunk_index, title, heading_level, content, start_line, end_line, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      // Remove files that no longer exist
      for (const [existingPath] of existingFiles) {
        if (!currentFiles.has(existingPath)) {
          deleteStmt.run(existingPath);
          filesRemoved++;
        }
      }

      // Add or update files
      for (const [currentPath, currentHash] of currentFiles) {
        const existingHash = existingFiles.get(currentPath);
        if (existingHash === currentHash) {
          // Unchanged — skip
          continue;
        }

        // Delete old chunks if updating
        if (existingHash !== undefined) {
          deleteStmt.run(currentPath);
          filesUpdated++;
        } else {
          filesAdded++;
        }

        // Read and chunk file
        const filePath = path.join(this.projectRoot, currentPath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const chunks = this.chunkFile(currentPath, content);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          insertStmt.run(
            currentPath,
            i,
            chunk.title,
            chunk.headingLevel,
            chunk.content,
            chunk.startLine,
            chunk.endLine,
            currentHash,
            Date.now()
          );
        }
      }

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    // Get total chunks
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM doc_chunks').get() as { cnt: number };

    return {
      filesUpdated,
      filesAdded,
      filesRemoved,
      chunksTotal: countRow.cnt,
    };
  }

  /**
   * Get document index status.
   */
  getStatus(): DocStatus {
    const fileRow = this.db.prepare(
      'SELECT COUNT(DISTINCT path) AS cnt FROM doc_chunks'
    ).get() as { cnt: number };
    const chunkRow = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM doc_chunks'
    ).get() as { cnt: number };
    const timeRow = this.db.prepare(
      'SELECT MAX(updated_at) AS ts FROM doc_chunks'
    ).get() as { ts: number | null };

    return {
      fileCount: fileRow.cnt,
      chunkCount: chunkRow.cnt,
      lastUpdatedAt: timeRow.ts,
    };
  }

  /**
   * Check if document tables exist in the database.
   */
  isInitialized(): boolean {
    try {
      const row = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='doc_chunks'"
      ).get() as { name: string } | undefined;
      return row !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Recursively scan for document files, respecting exclusion rules.
   */
  private scanDocFiles(): string[] {
    const result: string[] = [];
    this.scanDir(this.projectRoot, result);
    return result;
  }

  private scanDir(dir: string, result: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.projectRoot, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        // Check directory exclusion before descending
        const relDirPath = relativePath + '/';
        if (isDocExcluded(relDirPath + 'dummy.txt')) {
          continue; // Skip entire directory
        }
        this.scanDir(fullPath, result);
      } else if (entry.isFile()) {
        if (isDocExcluded(relativePath)) {
          continue;
        }
        if (isDocFile(relativePath)) {
          result.push(fullPath);
        }
      }
    }
  }

  /**
   * Choose the appropriate chunker based on file extension.
   */
  private chunkFile(relativePath: string, content: string): DocChunk[] {
    const ext = path.extname(relativePath).toLowerCase();
    if (ext === '.md') {
      return chunkMarkdown(content);
    }
    return chunkPlainText(content);
  }

  /**
   * Compute SHA-256 hash of file content.
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}
