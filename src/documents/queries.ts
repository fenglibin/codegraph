/**
 * Document Queries
 *
 * Provides search, outline, and read operations over indexed document chunks.
 */

import { SqliteDatabase } from '../db';

export interface DocSearchResult {
  path: string;
  title: string | null;
  headingLevel: number;
  content: string;
  startLine: number;
  endLine: number;
  rank: number;
}

export interface DocOutlineEntry {
  path: string;
  title: string | null;
  headingLevel: number;
  startLine: number;
}

export interface DocReadResult {
  path: string;
  title: string | null;
  content: string;
  startLine: number;
  endLine: number;
}

export class DocumentQueries {
  private db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Full-text search across all indexed documents using FTS5 BM25.
   *
   * @param query - Search keywords
   * @param limit - Maximum results (default 5)
   * @returns Matching chunks ranked by relevance
   */
  search(query: string, limit: number = 5): DocSearchResult[] {
    // Sanitize query for FTS5 (remove special chars that break the query)
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.db.prepare(
      `SELECT d.path, d.title, d.heading_level, d.content, d.start_line, d.end_line, rank
       FROM doc_chunks_fts f
       JOIN doc_chunks d ON d.id = f.rowid
       WHERE doc_chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    ).all(sanitized, limit) as Array<{
      path: string;
      title: string | null;
      heading_level: number;
      content: string;
      start_line: number;
      end_line: number;
      rank: number;
    }>;

    return rows.map(row => ({
      path: row.path,
      title: row.title,
      headingLevel: row.heading_level,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      rank: row.rank,
    }));
  }

  /**
   * Get the heading structure (outline) of documents.
   *
   * @param docPath - Optional: filter to a specific document path
   * @returns Heading entries ordered by path and position
   */
  outline(docPath?: string): DocOutlineEntry[] {
    let rows: Array<{ path: string; title: string | null; heading_level: number; start_line: number }>;

    if (docPath) {
      rows = this.db.prepare(
        `SELECT path, title, heading_level, start_line
         FROM doc_chunks
         WHERE path = ? AND heading_level > 0
         ORDER BY chunk_index`
      ).all(docPath) as Array<{ path: string; title: string | null; heading_level: number; start_line: number }>;
    } else {
      rows = this.db.prepare(
        `SELECT path, title, heading_level, start_line
         FROM doc_chunks
         WHERE heading_level > 0
         ORDER BY path, chunk_index`
      ).all() as Array<{ path: string; title: string | null; heading_level: number; start_line: number }>;
    }

    return rows.map(row => ({
      path: row.path,
      title: row.title,
      headingLevel: row.heading_level,
      startLine: row.start_line,
    }));
  }

  /**
   * Read a specific section (and its sub-sections) of a document.
   *
   * @param docPath - Document path
   * @param section - Optional section heading title to read
   * @returns The content of the section, or null if not found
   */
  read(docPath: string, section?: string): DocReadResult | null {
    if (!section) {
      // Return entire file content concatenated
      const rows = this.db.prepare(
        `SELECT path, title, content, start_line, end_line
         FROM doc_chunks
         WHERE path = ?
         ORDER BY chunk_index`
      ).all(docPath) as Array<{
        path: string;
        title: string | null;
        content: string;
        start_line: number;
        end_line: number;
      }>;

      if (rows.length === 0) return null;

      const content = rows.map(r => r.content).join('\n\n');
      return {
        path: docPath,
        title: null,
        content,
        startLine: rows[0]!.start_line,
        endLine: rows[rows.length - 1]!.end_line,
      };
    }

    // Find the target section
    const allChunks = this.db.prepare(
      `SELECT chunk_index, title, heading_level, content, start_line, end_line
       FROM doc_chunks
       WHERE path = ?
       ORDER BY chunk_index`
    ).all(docPath) as Array<{
      chunk_index: number;
      title: string | null;
      heading_level: number;
      content: string;
      start_line: number;
      end_line: number;
    }>;

    if (allChunks.length === 0) return null;

    // Find the chunk matching the section title
    const targetIdx = allChunks.findIndex(
      c => c.title !== null && c.title.toLowerCase() === section.toLowerCase()
    );
    if (targetIdx === -1) return null;

    const target = allChunks[targetIdx]!;
    const targetLevel = target.heading_level;

    // Collect the target chunk and all sub-level chunks until next same-level or higher
    const sectionChunks = [target];
    for (let i = targetIdx + 1; i < allChunks.length; i++) {
      const c = allChunks[i]!;
      if (c.heading_level > 0 && c.heading_level <= targetLevel) {
        break; // Next same-level or higher-level heading = end of section
      }
      sectionChunks.push(c);
    }

    const content = sectionChunks.map(c => c.content).join('\n\n');
    return {
      path: docPath,
      title: target.title,
      content,
      startLine: target.start_line,
      endLine: sectionChunks[sectionChunks.length - 1]!.end_line,
    };
  }

  /**
   * Check if document tables exist.
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
   * Sanitize a query string for FTS5 MATCH.
   * Removes operators and special characters that could cause FTS5 syntax errors.
   */
  private sanitizeFtsQuery(query: string): string {
    // Remove FTS5 special characters and operators
    let sanitized = query
      .replace(/[*"(){}[\]^~:]/g, ' ')  // Remove special FTS5 chars
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')  // Remove operators
      .trim()
      .replace(/\s+/g, ' ');  // Normalize whitespace

    // If nothing left, return empty
    if (!sanitized.trim()) return '';

    // Split into words and join with implicit AND (space between terms)
    return sanitized;
  }
}
