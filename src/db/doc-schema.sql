-- CodeGraph Document Search Schema
-- Stores document chunks for FTS5-based full-text search

-- Document chunks table
CREATE TABLE IF NOT EXISTS doc_chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT NOT NULL,              -- Relative path: docs/deploy.md
    chunk_index   INTEGER NOT NULL,           -- Chunk order within file: 0, 1, 2...
    title         TEXT,                       -- Heading text (without # prefix)
    heading_level INTEGER NOT NULL DEFAULT 0, -- 0=no heading, 1=h1, 2=h2, ...
    content       TEXT NOT NULL,              -- Full chunk content (including heading line)
    start_line    INTEGER NOT NULL,           -- 1-indexed
    end_line      INTEGER NOT NULL,           -- 1-indexed, inclusive
    content_hash  TEXT NOT NULL,              -- File-level SHA-256 hash for incremental sync
    updated_at    INTEGER NOT NULL            -- Unix timestamp in ms
);

-- Unique index: one chunk per (path, chunk_index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_chunks_path_chunk
    ON doc_chunks(path, chunk_index);

-- Index for path-based lookups
CREATE INDEX IF NOT EXISTS idx_doc_chunks_path
    ON doc_chunks(path);

-- FTS5 full-text search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
    title,
    content,
    content='doc_chunks',
    content_rowid='id',
    tokenize='unicode61'
);

-- Trigger: sync FTS on INSERT
CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;

-- Trigger: sync FTS on DELETE
CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;

-- Trigger: sync FTS on UPDATE
CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO doc_chunks_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;
