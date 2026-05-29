/**
 * Documents Module
 *
 * Re-exports all document search functionality.
 */

export { DocChunk, chunkMarkdown, chunkPlainText } from './chunker';
export { DOCS_DEFAULT_EXCLUDES, DOCS_SUPPORTED_EXTENSIONS, isDocExcluded, isDocFile } from './excludes';
export { DocumentIndexer, DocIndexResult, DocSyncResult, DocStatus } from './indexer';
export { DocumentQueries, DocSearchResult, DocOutlineEntry, DocReadResult } from './queries';
