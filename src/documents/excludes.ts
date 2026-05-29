/**
 * Document Exclusion Rules
 *
 * Defines which directories/files to exclude from document indexing,
 * and which file extensions are considered documents.
 */

/**
 * Default directory patterns to exclude from document indexing.
 * These cover common build outputs, dependency directories, and caches
 * across all major language ecosystems.
 */
export const DOCS_DEFAULT_EXCLUDES: string[] = [
  // === General ===
  '.git/',
  '.svn/',
  '.hg/',
  '.codegraph/',
  '.DS_Store',

  // === Node.js / JavaScript / TypeScript ===
  'node_modules/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.cache/',
  '.parcel-cache/',
  'coverage/',

  // === Python ===
  '.venv/',
  'venv/',
  'env/',
  '.env/',
  '__pycache__/',
  '*.egg-info/',
  '.eggs/',
  'site-packages/',
  '.tox/',
  '.nox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',

  // === Java / Kotlin ===
  'target/',
  '.gradle/',
  '.idea/',

  // === Go ===
  'vendor/',

  // === Rust ===
  // (target/ already covered by Java)

  // === C / C++ ===
  'cmake-build-*/',
  '.ccache/',

  // === PHP ===
  // (vendor/ already covered by Go)

  // === Ruby ===
  'vendor/bundle/',
  '.bundle/',

  // === Dart / Flutter ===
  '.dart_tool/',
  '.pub-cache/',

  // === .NET / C# ===
  'packages/',

  // === General Build Outputs ===
  'dist/',
  'build/',
  'out/',
  'bin/',
  'obj/',
  '_build/',
];

/**
 * Supported document file extensions (lowercase, with dot).
 */
export const DOCS_SUPPORTED_EXTENSIONS = ['.md', '.txt'];

/**
 * Special filenames that are recognized as documents even without an extension.
 */
const DOCS_EXTENSIONLESS_FILES = ['README', 'CHANGELOG', 'LICENSE', 'CHANGES', 'AUTHORS', 'CONTRIBUTORS'];

/**
 * Check if a relative path should be excluded from document indexing.
 *
 * @param relativePath - Path relative to the project root (forward slashes)
 * @returns true if the path should be excluded
 */
export function isDocExcluded(relativePath: string): boolean {
  // Normalize to forward slashes
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  for (const pattern of DOCS_DEFAULT_EXCLUDES) {
    if (pattern.endsWith('/')) {
      // Directory pattern — match any segment in the path
      const dirName = pattern.slice(0, -1); // Remove trailing /

      if (dirName.includes('*')) {
        // Wildcard pattern (e.g., "cmake-build-*")
        const regex = new RegExp('^' + escapeRegExp(dirName).replace(/\\\*/g, '.*') + '$');
        for (const seg of segments.slice(0, -1)) { // Don't match the filename itself
          if (regex.test(seg)) return true;
        }
      } else {
        // Exact directory name match
        for (const seg of segments.slice(0, -1)) { // Don't match the filename itself
          if (seg === dirName) return true;
        }
      }
    } else if (pattern.includes('*')) {
      // Wildcard file pattern (e.g., "*.egg-info/")
      const regex = new RegExp('^' + escapeRegExp(pattern).replace(/\\\*/g, '.*') + '$');
      for (const seg of segments) {
        if (regex.test(seg)) return true;
      }
    } else {
      // Exact filename match (e.g., ".DS_Store")
      const fileName = segments[segments.length - 1];
      if (fileName === pattern) return true;
    }
  }

  return false;
}

/**
 * Check if a file path is a supported document file.
 *
 * @param filePath - File path (can be relative or absolute)
 * @returns true if the file is a recognized document type
 */
export function isDocFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() || '';

  // Check extension
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex > 0) {
    const ext = fileName.slice(dotIndex).toLowerCase();
    return DOCS_SUPPORTED_EXTENSIONS.includes(ext);
  }

  // No extension — check special filenames
  return DOCS_EXTENSIONLESS_FILES.includes(fileName);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
