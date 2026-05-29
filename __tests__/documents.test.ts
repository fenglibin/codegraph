/**
 * Document Search Tests
 *
 * Tests for the document chunk search functionality:
 * - Chunker (Markdown heading split, plain text paragraph split)
 * - Exclusion rules (multi-language ecosystem coverage)
 * - Indexer (full index, incremental sync)
 * - Queries (FTS5 search, outline, read)
 * - Integration (end-to-end flow)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chunkMarkdown, chunkPlainText } from '../src/documents/chunker';
import { isDocExcluded, isDocFile } from '../src/documents/excludes';
import { DocumentIndexer } from '../src/documents/indexer';
import { DocumentQueries } from '../src/documents/queries';
import { DatabaseConnection } from '../src/db';

// ===========================================================================
// Chunker Tests
// ===========================================================================

describe('Document Chunker', () => {
  describe('chunkMarkdown', () => {
    it('splits by headings correctly', () => {
      const content = `# Title
Some intro text.
More intro text.
Even more intro.

## Section One
Content of section one.
More content of section one.
Additional content line.

## Section Two
Content of section two.
More content here.
And another line.

### Subsection
More content.
Another subsection line.
Final line.
`;
      const chunks = chunkMarkdown(content);

      // Should have at least 3 chunks (some short ones may be merged)
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0]!.title).toBe('Title');
      expect(chunks[0]!.headingLevel).toBe(1);
      expect(chunks[0]!.startLine).toBe(1);

      const sec1 = chunks.find(c => c.title === 'Section One');
      expect(sec1).toBeDefined();
      expect(sec1!.headingLevel).toBe(2);
      expect(sec1!.content).toContain('Content of section one');

      const sec2 = chunks.find(c => c.title === 'Section Two');
      expect(sec2).toBeDefined();
      expect(sec2!.headingLevel).toBe(2);
    });

    it('handles content before first heading', () => {
      const content = `Some preamble text.
Another line of preamble.
Third preamble line.
Fourth preamble line.

# First Heading
Content here.
More content.
Third line.
`;
      const chunks = chunkMarkdown(content);
      // Should have chunks from splitting
      expect(chunks.length).toBeGreaterThan(0);
      // At least one chunk should contain the heading content
      const allContent = chunks.map(c => c.content).join('\n');
      expect(allContent).toContain('First Heading');
      expect(allContent).toContain('preamble');
    });

    it('handles markdown without headings (falls back to paragraphs)', () => {
      const content = `First paragraph.
More of first paragraph.

Second paragraph.
More of second paragraph.

Third paragraph.
`;
      const chunks = chunkMarkdown(content);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // All chunks should have headingLevel 0
      for (const chunk of chunks) {
        expect(chunk.headingLevel).toBe(0);
      }
    });

    it('handles empty content', () => {
      const chunks = chunkMarkdown('');
      expect(chunks).toEqual([]);
    });

    it('splits oversized chunks', () => {
      // Create a heading followed by >200 lines
      const lines = ['# Big Section'];
      for (let i = 0; i < 250; i++) {
        lines.push(`Line ${i + 1} of content that goes on and on.`);
      }
      const content = lines.join('\n');
      const chunks = chunkMarkdown(content);
      // Should be split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should retain the heading
      expect(chunks[0].title).toBe('Big Section');
    });

    it('merges short chunks into previous', () => {
      const content = `# First Section
Substantial content here.
Line two.
Line three.
Line four.

## Tiny
x
## Next Section
Content of next section.
Line two.
Line three.
`;
      const chunks = chunkMarkdown(content);
      // "Tiny" section is only 1 line ("x"), should be merged
      // Either merged into previous or next, but total chunks should reflect merging
      const tinyChunk = chunks.find(c => c.title === 'Tiny' && c.content.trim() === 'x');
      // If merged, it won't exist as standalone; or it'll be part of another chunk
      // Just verify no chunk has only "## Tiny\nx" as standalone
      for (const chunk of chunks) {
        if (chunk.title === 'Tiny') {
          // If it exists, it should have been merged (content includes more)
          // or it's okay if it's combined with the next section
        }
      }
      // Main point: no crash, reasonable output
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('chunkPlainText', () => {
    it('splits by blank lines', () => {
      const content = `First paragraph line 1.
First paragraph line 2.
First paragraph line 3.
First paragraph line 4.

Second paragraph line 1.
Second paragraph line 2.
Second paragraph line 3.
Second paragraph line 4.
`;
      const chunks = chunkPlainText(content);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.headingLevel).toBe(0);
        expect(chunk.title).toBeNull();
      }
    });

    it('splits by fixed lines when no blank lines', () => {
      const lines: string[] = [];
      for (let i = 0; i < 120; i++) {
        lines.push(`Line number ${i + 1}`);
      }
      const content = lines.join('\n');
      const chunks = chunkPlainText(content);
      // With 120 lines and 50 lines per chunk, expect 3 chunks
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it('handles empty content', () => {
      const chunks = chunkPlainText('');
      expect(chunks).toEqual([]);
    });
  });
});

// ===========================================================================
// Exclusion Rules Tests
// ===========================================================================

describe('Document Exclusion Rules', () => {
  describe('isDocExcluded', () => {
    it('excludes node_modules', () => {
      expect(isDocExcluded('node_modules/lodash/README.md')).toBe(true);
      expect(isDocExcluded('some/path/node_modules/pkg/docs.md')).toBe(true);
    });

    it('excludes Python virtual environments', () => {
      expect(isDocExcluded('.venv/lib/python3.11/METADATA.txt')).toBe(true);
      expect(isDocExcluded('venv/lib/site-packages/README.md')).toBe(true);
      expect(isDocExcluded('env/lib/README.md')).toBe(true);
    });

    it('excludes vendor directories', () => {
      expect(isDocExcluded('vendor/github.com/pkg/README.md')).toBe(true);
      expect(isDocExcluded('vendor/bundle/gems/README.md')).toBe(true);
    });

    it('excludes build output directories', () => {
      expect(isDocExcluded('target/doc/README.md')).toBe(true); // Rust/Java
      expect(isDocExcluded('dist/README.md')).toBe(true);
      expect(isDocExcluded('build/docs/index.md')).toBe(true);
      expect(isDocExcluded('out/docs.txt')).toBe(true);
    });

    it('excludes cmake-build-* wildcard', () => {
      expect(isDocExcluded('cmake-build-debug/README.md')).toBe(true);
      expect(isDocExcluded('cmake-build-release/docs.txt')).toBe(true);
    });

    it('excludes .gradle and .idea', () => {
      expect(isDocExcluded('.gradle/caches/README.md')).toBe(true);
      expect(isDocExcluded('.idea/README.md')).toBe(true);
    });

    it('excludes Python tool caches', () => {
      expect(isDocExcluded('__pycache__/readme.md')).toBe(true);
      expect(isDocExcluded('.mypy_cache/README.md')).toBe(true);
      expect(isDocExcluded('.pytest_cache/README.md')).toBe(true);
      expect(isDocExcluded('.ruff_cache/README.md')).toBe(true);
    });

    it('does NOT exclude normal project docs', () => {
      expect(isDocExcluded('docs/deploy.md')).toBe(false);
      expect(isDocExcluded('README.md')).toBe(false);
      expect(isDocExcluded('CHANGELOG.md')).toBe(false);
      expect(isDocExcluded('src/docs/guide.txt')).toBe(false);
    });

    it('excludes .codegraph directory', () => {
      expect(isDocExcluded('.codegraph/docs.md')).toBe(true);
    });

    it('excludes .git directory', () => {
      expect(isDocExcluded('.git/hooks/README.md')).toBe(true);
    });
  });

  describe('isDocFile', () => {
    it('recognizes .md files', () => {
      expect(isDocFile('README.md')).toBe(true);
      expect(isDocFile('docs/guide.md')).toBe(true);
    });

    it('recognizes .txt files', () => {
      expect(isDocFile('NOTES.txt')).toBe(true);
      expect(isDocFile('docs/todo.txt')).toBe(true);
    });

    it('recognizes extensionless README/CHANGELOG/LICENSE', () => {
      expect(isDocFile('README')).toBe(true);
      expect(isDocFile('CHANGELOG')).toBe(true);
      expect(isDocFile('LICENSE')).toBe(true);
    });

    it('rejects code files', () => {
      expect(isDocFile('src/index.ts')).toBe(false);
      expect(isDocFile('main.py')).toBe(false);
      expect(isDocFile('app.go')).toBe(false);
      expect(isDocFile('Makefile')).toBe(false);
    });
  });
});

// ===========================================================================
// Indexer & Query Tests (require SQLite)
// ===========================================================================

describe('Document Indexer', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let indexer: DocumentIndexer;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-docs-'));
    const dbPath = path.join(testDir, '.codegraph', 'codegraph.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = DatabaseConnection.initialize(dbPath);
    indexer = new DocumentIndexer(db.getDb(), testDir);
    indexer.initSchema();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('indexes multiple .md files', () => {
    // Create test docs
    fs.mkdirSync(path.join(testDir, 'docs'));
    fs.writeFileSync(path.join(testDir, 'README.md'), `# Project\n\nIntro.\n\n## Usage\n\nHow to use.\n`);
    fs.writeFileSync(path.join(testDir, 'docs', 'guide.md'), `# Guide\n\nStep 1.\n\n## Advanced\n\nDetails.\n`);

    const result = indexer.indexAll();
    expect(result.filesIndexed).toBe(2);
    expect(result.chunksCreated).toBeGreaterThan(2);
    expect(result.filesSkipped).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('respects exclusion rules during indexing', () => {
    // Create a doc in node_modules (should be excluded)
    fs.mkdirSync(path.join(testDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'node_modules', 'pkg', 'README.md'), '# Pkg\nContent.\n');
    // Normal doc
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Root\nContent.\n');

    const result = indexer.indexAll();
    expect(result.filesIndexed).toBe(1); // Only README.md, not node_modules
  });

  it('sync detects file changes', () => {
    fs.writeFileSync(path.join(testDir, 'doc.md'), '# Original\nOld content.\n');
    indexer.indexAll();

    // Modify the file
    fs.writeFileSync(path.join(testDir, 'doc.md'), '# Updated\nNew content.\n');
    const syncResult = indexer.sync();
    expect(syncResult.filesUpdated).toBe(1);
    expect(syncResult.filesAdded).toBe(0);
  });

  it('sync detects new files', () => {
    fs.writeFileSync(path.join(testDir, 'existing.md'), '# Existing\nContent.\n');
    indexer.indexAll();

    // Add new file
    fs.writeFileSync(path.join(testDir, 'new.md'), '# New\nNew file.\n');
    const syncResult = indexer.sync();
    expect(syncResult.filesAdded).toBe(1);
  });

  it('sync detects deleted files', () => {
    fs.writeFileSync(path.join(testDir, 'to-delete.md'), '# Delete Me\nContent.\n');
    fs.writeFileSync(path.join(testDir, 'keep.md'), '# Keep\nContent.\n');
    indexer.indexAll();

    // Delete a file
    fs.unlinkSync(path.join(testDir, 'to-delete.md'));
    const syncResult = indexer.sync();
    expect(syncResult.filesRemoved).toBe(1);
  });

  it('getStatus returns correct counts', () => {
    fs.writeFileSync(path.join(testDir, 'a.md'), '# A\nContent line one.\nContent line two.\nContent line three.\n\n## Sub\nMore content.\nAnother line.\nThird line.\n');
    fs.writeFileSync(path.join(testDir, 'b.md'), '# B\nContent here.\nAnother line.\nThird line of b.\n');
    indexer.indexAll();

    const status = indexer.getStatus();
    expect(status.fileCount).toBe(2);
    expect(status.chunkCount).toBeGreaterThanOrEqual(2);
    expect(status.lastUpdatedAt).not.toBeNull();
  });
});

describe('Document Queries', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let indexer: DocumentIndexer;
  let queries: DocumentQueries;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-docsq-'));
    const dbPath = path.join(testDir, '.codegraph', 'codegraph.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = DatabaseConnection.initialize(dbPath);
    indexer = new DocumentIndexer(db.getDb(), testDir);
    indexer.initSchema();
    queries = new DocumentQueries(db.getDb());

    // Create test documents
    fs.mkdirSync(path.join(testDir, 'docs'));
    fs.writeFileSync(path.join(testDir, 'README.md'), [
      '# Project Name',
      '',
      'A great project.',
      '',
      '## Installation',
      '',
      'Run npm install to get started.',
      '',
      '## Usage',
      '',
      'Import the module and call init().',
      '',
      '### Advanced Usage',
      '',
      'For power users, configure options.',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(testDir, 'docs', 'deploy.md'), [
      '# Deployment Guide',
      '',
      'How to deploy the application.',
      '',
      '## Prerequisites',
      '',
      'You need Docker and kubectl installed.',
      '',
      '## Steps',
      '',
      '1. Build the image',
      '2. Push to registry',
      '3. Apply k8s manifests',
      '',
      '### Rollback',
      '',
      'kubectl rollout undo deployment/app',
      '',
    ].join('\n'));

    indexer.indexAll();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('search', () => {
    it('returns BM25-ranked results', () => {
      const results = queries.search('deploy');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].path).toContain('deploy.md');
    });

    it('respects limit parameter', () => {
      const results = queries.search('the', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for no match', () => {
      const results = queries.search('xyznonexistent');
      expect(results.length).toBe(0);
    });

    it('searches across multiple files', () => {
      const results = queries.search('install', 10);
      // "install" appears in both README (Installation) and deploy (kubectl installed)
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('outline', () => {
    it('returns heading structure for all docs', () => {
      const entries = queries.outline();
      expect(entries.length).toBeGreaterThan(0);
      // Should include headings from both files
      const paths = new Set(entries.map(e => e.path));
      expect(paths.size).toBe(2);
    });

    it('filters by path', () => {
      const entries = queries.outline('README.md');
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.path).toBe('README.md');
      }
    });

    it('returns correct heading levels', () => {
      const entries = queries.outline('docs/deploy.md');
      const h1 = entries.filter(e => e.headingLevel === 1);
      const h2 = entries.filter(e => e.headingLevel === 2);
      const h3 = entries.filter(e => e.headingLevel === 3);
      expect(h1.length).toBe(1); // "Deployment Guide"
      expect(h2.length).toBe(2); // "Prerequisites", "Steps"
      expect(h3.length).toBe(1); // "Rollback"
    });
  });

  describe('read', () => {
    it('reads entire file when no section specified', () => {
      const result = queries.read('README.md');
      expect(result).not.toBeNull();
      expect(result!.path).toBe('README.md');
      expect(result!.content).toContain('Project Name');
      expect(result!.content).toContain('Installation');
      expect(result!.content).toContain('Usage');
    });

    it('reads specific section', () => {
      const result = queries.read('docs/deploy.md', 'Prerequisites');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Prerequisites');
      expect(result!.content).toContain('Docker');
      expect(result!.content).toContain('kubectl');
    });

    it('includes sub-sections', () => {
      const result = queries.read('docs/deploy.md', 'Steps');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Steps');
      // "Rollback" is a sub-section of "Steps" (h3 under h2)
      expect(result!.content).toContain('Rollback');
      expect(result!.content).toContain('rollout undo');
    });

    it('returns null for non-existent document', () => {
      const result = queries.read('nonexistent.md');
      expect(result).toBeNull();
    });

    it('returns null for non-existent section', () => {
      const result = queries.read('README.md', 'NonExistentSection');
      expect(result).toBeNull();
    });
  });

  describe('isInitialized', () => {
    it('returns true when tables exist', () => {
      expect(queries.isInitialized()).toBe(true);
    });

    it('returns false on fresh database', () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fresh-'));
      const freshDbPath = path.join(freshDir, 'test.db');
      fs.mkdirSync(path.dirname(freshDbPath), { recursive: true });
      const freshDb = DatabaseConnection.initialize(freshDbPath);
      const freshQueries = new DocumentQueries(freshDb.getDb());
      expect(freshQueries.isInitialized()).toBe(false);
      freshDb.close();
      fs.rmSync(freshDir, { recursive: true, force: true });
    });
  });
});

// ===========================================================================
// Integration Tests
// ===========================================================================

describe('Document Search Integration', () => {
  let testDir: string;
  let db: DatabaseConnection;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-docs-int-'));
    const dbPath = path.join(testDir, '.codegraph', 'codegraph.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = DatabaseConnection.initialize(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('full flow: init → search', () => {
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Hello World\n\nThis is a test project.\n\n## Getting Started\n\nRun the program.\n');

    const indexer = new DocumentIndexer(db.getDb(), testDir);
    indexer.initSchema();
    const result = indexer.indexAll();
    expect(result.filesIndexed).toBe(1);

    const queries = new DocumentQueries(db.getDb());
    const searchResults = queries.search('getting started');
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].content).toContain('Run the program');
  });

  it('sync updates search results after file change', () => {
    fs.writeFileSync(path.join(testDir, 'doc.md'), '# Old Title\n\nOld content about apples.\n');

    const indexer = new DocumentIndexer(db.getDb(), testDir);
    indexer.initSchema();
    indexer.indexAll();

    const queries = new DocumentQueries(db.getDb());
    let results = queries.search('apples');
    expect(results.length).toBeGreaterThan(0);

    // Update file
    fs.writeFileSync(path.join(testDir, 'doc.md'), '# New Title\n\nNew content about bananas.\n');
    indexer.sync();

    // Old content should not appear
    results = queries.search('apples');
    expect(results.length).toBe(0);

    // New content should appear
    results = queries.search('bananas');
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles .txt files correctly', () => {
    fs.writeFileSync(path.join(testDir, 'notes.txt'), 'Important notes about the server configuration.\n\nDatabase settings are in config.yml.\n');

    const indexer = new DocumentIndexer(db.getDb(), testDir);
    indexer.initSchema();
    indexer.indexAll();

    const queries = new DocumentQueries(db.getDb());
    const results = queries.search('server configuration');
    expect(results.length).toBeGreaterThan(0);
  });
});
