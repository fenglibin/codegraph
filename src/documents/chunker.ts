/**
 * Document Chunker
 *
 * Splits document files into searchable chunks:
 * - Markdown: split by headings (# ## ### etc.)
 * - Plain text: split by blank lines or fixed line count
 */

/**
 * A single chunk of a document.
 */
export interface DocChunk {
  /** Heading text (without # prefix), null if no heading */
  title: string | null;
  /** 0=no heading, 1-6 = heading level */
  headingLevel: number;
  /** Full content of the chunk (including heading line) */
  content: string;
  /** 1-indexed start line */
  startLine: number;
  /** 1-indexed end line (inclusive) */
  endLine: number;
}

/** Maximum chunk size in lines */
const MAX_CHUNK_LINES = 200;
/** Maximum chunk size in characters */
const MAX_CHUNK_CHARS = 4000;
/** Minimum chunk size in lines (below this, merge into previous) */
const MIN_CHUNK_LINES = 3;
/** Fixed line count for plain text without blank lines */
const PLAIN_TEXT_FIXED_LINES = 50;

/**
 * Split a Markdown document into chunks by headings.
 *
 * Each heading starts a new chunk. Content before the first heading
 * (if any) becomes chunk 0 with headingLevel = 0.
 *
 * @param content - Full markdown file content
 * @returns Array of document chunks
 */
export function chunkMarkdown(content: string): DocChunk[] {
  if (!content || content.trim().length === 0) return [];

  const lines = content.split('\n');
  if (lines.length === 0) return [];

  // Remove trailing empty line from split (if file ends with \n)
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  if (lines.length === 0) return [];

  const rawChunks: DocChunk[] = [];
  let currentChunk: { title: string | null; headingLevel: number; lines: string[]; startLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Save current chunk if exists
      if (currentChunk) {
        rawChunks.push(buildChunk(currentChunk));
      }
      // Start new chunk
      currentChunk = {
        title: headingMatch[2]!.trim(),
        headingLevel: headingMatch[1]!.length,
        lines: [line],
        startLine: i + 1,
      };
    } else {
      if (!currentChunk) {
        // Content before first heading
        currentChunk = {
          title: null,
          headingLevel: 0,
          lines: [line],
          startLine: 1,
        };
      } else {
        currentChunk.lines.push(line);
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunk) {
    rawChunks.push(buildChunk(currentChunk));
  }

  // If no headings found, fall back to paragraph splitting
  if (rawChunks.length === 1 && rawChunks[0]!.headingLevel === 0) {
    return chunkByParagraphs(lines);
  }

  // Post-process: merge short chunks and split oversized ones
  return postProcess(rawChunks);
}

/**
 * Split a plain text document into chunks by blank lines.
 * If no blank lines exist, split by fixed line count.
 *
 * @param content - Full plain text file content
 * @returns Array of document chunks
 */
export function chunkPlainText(content: string): DocChunk[] {
  if (!content || content.trim().length === 0) return [];

  const lines = content.split('\n');

  // Remove trailing empty line
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  if (lines.length === 0 || (lines.length === 1 && lines[0]!.trim() === '')) return [];

  // Check if there are blank lines (paragraph separators)
  const hasBlankLines = lines.some((line, i) => line.trim() === '' && i > 0 && i < lines.length - 1);

  if (hasBlankLines) {
    return chunkByParagraphs(lines);
  }

  // No blank lines — split by fixed line count
  return chunkByFixedLines(lines, PLAIN_TEXT_FIXED_LINES);
}

/**
 * Split lines into chunks by blank line boundaries.
 */
function chunkByParagraphs(lines: string[]): DocChunk[] {
  const rawChunks: DocChunk[] = [];
  let currentLines: string[] = [];
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim() === '' && currentLines.length > 0) {
      // End of paragraph — but include the blank line in current chunk
      currentLines.push(line);

      // Check if next line is also blank (consecutive blanks = definite break)
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (i + 1 >= lines.length || (nextLine !== undefined && nextLine.trim() === '')) {
        rawChunks.push({
          title: null,
          headingLevel: 0,
          content: currentLines.join('\n'),
          startLine,
          endLine: startLine + currentLines.length - 1,
        });
        currentLines = [];
        startLine = i + 2;
      }
    } else if (line.trim() === '' && currentLines.length === 0) {
      // Skip leading blank lines
      startLine = i + 2;
    } else {
      currentLines.push(line);
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    rawChunks.push({
      title: null,
      headingLevel: 0,
      content: currentLines.join('\n'),
      startLine,
      endLine: startLine + currentLines.length - 1,
    });
  }

  return postProcess(rawChunks);
}

/**
 * Split lines into fixed-size chunks.
 */
function chunkByFixedLines(lines: string[], chunkSize: number): DocChunk[] {
  const chunks: DocChunk[] = [];

  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunkLines = lines.slice(i, Math.min(i + chunkSize, lines.length));
    chunks.push({
      title: null,
      headingLevel: 0,
      content: chunkLines.join('\n'),
      startLine: i + 1,
      endLine: i + chunkLines.length,
    });
  }

  return chunks;
}

/**
 * Post-process chunks: merge short chunks into previous, split oversized chunks.
 */
function postProcess(chunks: DocChunk[]): DocChunk[] {
  if (chunks.length === 0) return chunks;

  // Step 1: Merge short chunks into previous
  const merged: DocChunk[] = [];
  for (const chunk of chunks) {
    const lineCount = chunk.endLine - chunk.startLine + 1;
    if (lineCount < MIN_CHUNK_LINES && merged.length > 0) {
      // Merge into previous chunk
      const prev = merged[merged.length - 1]!;
      prev.content = prev.content + '\n' + chunk.content;
      prev.endLine = chunk.endLine;
    } else {
      merged.push({ ...chunk });
    }
  }

  // Step 2: Split oversized chunks
  const result: DocChunk[] = [];
  for (const chunk of merged) {
    const lineCount = chunk.endLine - chunk.startLine + 1;
    if (lineCount > MAX_CHUNK_LINES || chunk.content.length > MAX_CHUNK_CHARS) {
      result.push(...splitOversizedChunk(chunk));
    } else {
      result.push(chunk);
    }
  }

  return result;
}

/**
 * Split an oversized chunk at paragraph boundaries.
 */
function splitOversizedChunk(chunk: DocChunk): DocChunk[] {
  const lines = chunk.content.split('\n');
  const result: DocChunk[] = [];
  let currentLines: string[] = [];
  let currentStartLine = chunk.startLine;
  let isFirst = true;

  for (let i = 0; i < lines.length; i++) {
    currentLines.push(lines[i]!);

    const shouldSplit =
      currentLines.length >= MAX_CHUNK_LINES ||
      currentLines.join('\n').length >= MAX_CHUNK_CHARS;

    // Try to split at a paragraph boundary (blank line)
    if (shouldSplit) {
      // Look backward for a blank line to split at
      let splitAt = currentLines.length;
      for (let j = currentLines.length - 1; j > Math.floor(currentLines.length / 2); j--) {
        if (currentLines[j]!.trim() === '') {
          splitAt = j + 1;
          break;
        }
      }

      const splitLines = currentLines.slice(0, splitAt);
      result.push({
        title: isFirst ? chunk.title : null,
        headingLevel: isFirst ? chunk.headingLevel : 0,
        content: splitLines.join('\n'),
        startLine: currentStartLine,
        endLine: currentStartLine + splitLines.length - 1,
      });

      currentLines = currentLines.slice(splitAt);
      currentStartLine = currentStartLine + splitAt;
      isFirst = false;
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    result.push({
      title: isFirst ? chunk.title : null,
      headingLevel: isFirst ? chunk.headingLevel : 0,
      content: currentLines.join('\n'),
      startLine: currentStartLine,
      endLine: currentStartLine + currentLines.length - 1,
    });
  }

  return result;
}

/**
 * Build a DocChunk from accumulated lines.
 */
function buildChunk(data: { title: string | null; headingLevel: number; lines: string[]; startLine: number }): DocChunk {
  // Trim trailing empty lines
  while (data.lines.length > 0 && data.lines[data.lines.length - 1]!.trim() === '') {
    data.lines.pop();
  }

  return {
    title: data.title,
    headingLevel: data.headingLevel,
    content: data.lines.join('\n'),
    startLine: data.startLine,
    endLine: data.startLine + data.lines.length - 1,
  };
}
