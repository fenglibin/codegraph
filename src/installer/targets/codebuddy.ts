/**
 * CodeBuddy IDE target.
 *
 *   - MCP server entry to `~/.codebuddy/mcp.json` (global) or
 *     `<workspace>/.mcp.json` (local). Same `{mcpServers: {...}}` shape
 *     as Claude / Cursor. The project-level `.mcp.json` is the path
 *     CodeBuddy IDE officially supports since v4.0.0 — see the release
 *     notes "新增项目级 MCP 支持，可在项目根目录中配置 .mcp.json 文件".
 *   - Instructions to `~/.codebuddy/rules/codegraph/RULE.mdc` (global,
 *     with `.mdc` frontmatter `alwaysApply: true`) or
 *     `<workspace>/CODEBUDDY.md` (local, marker-delimited block).
 *     When the workspace has no `CODEBUDDY.md` but does have an
 *     `AGENTS.md`, we write into `AGENTS.md` instead — honoring
 *     CodeBuddy's documented fallback: "当项目根目录存在 AGENTS.md 而不存在
 *     CODEBUDDY.md 时，CodeBuddy 将自动加载 AGENTS.md 的完整内容到对话上下文中".
 *   - No permissions concept. `opts.autoAllow` is silently ignored —
 *     same as Cursor / Codex / opencode.
 *
 * ## User-level MCP path caveat
 *
 * CodeBuddy IDE's user-level MCP file path is not explicitly documented;
 * the IDE's Settings UI is the canonical user-level config surface. We
 * write to `~/.codebuddy/mcp.json` because (a) `~/.codebuddy/` is
 * CodeBuddy's user config root (it already hosts `settings.json`,
 * `models.json`, `commands/`, `rules/`), (b) the file shape is identical
 * to project-level `.mcp.json`, and (c) Cursor follows the very same
 * `~/.cursor/mcp.json` pattern. We emit a `WriteResult.notes` advisory
 * on every global install so the user can confirm pickup in the IDE.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

/** CodeBuddy user-level config root — co-located with settings.json, models.json, etc. */
function userConfigDir(): string {
  return path.join(os.homedir(), '.codebuddy');
}

function mcpJsonPath(loc: Location): string {
  // global → ~/.codebuddy/mcp.json (user scope).
  // local  → ./.mcp.json (project scope, CodeBuddy v4.0.0+).
  return loc === 'global'
    ? path.join(userConfigDir(), 'mcp.json')
    : path.join(process.cwd(), '.mcp.json');
}

/** Global instructions file: a `.mdc` user rule auto-loaded by alwaysApply. */
function userRulePath(): string {
  return path.join(userConfigDir(), 'rules', 'codegraph', 'RULE.mdc');
}

/** Preferred local instructions file. */
function codebuddyMdPath(): string {
  return path.join(process.cwd(), 'CODEBUDDY.md');
}

/** Documented fallback file CodeBuddy reads when CODEBUDDY.md is absent. */
function agentsMdPath(): string {
  return path.join(process.cwd(), 'AGENTS.md');
}

/**
 * Pick the local instructions file CodeBuddy will actually read.
 * Strategy: prefer `CODEBUDDY.md`. Fall back to `AGENTS.md` only when
 * `CODEBUDDY.md` doesn't exist AND `AGENTS.md` does. Otherwise create
 * `CODEBUDDY.md`. Single deterministic rule — never writes both.
 */
function resolveLocalInstructionsPath(): string {
  const md = codebuddyMdPath();
  if (fs.existsSync(md)) return md;
  const agents = agentsMdPath();
  if (fs.existsSync(agents)) return agents;
  return md;
}

function instructionsPath(loc: Location): string {
  return loc === 'global' ? userRulePath() : resolveLocalInstructionsPath();
}

/**
 * Frontmatter for the user-level `.mdc` rule file. `alwaysApply: true`
 * makes the rule auto-load into every CodeBuddy session — matching what
 * Cursor does with its own `.mdc` frontmatter, and the right behavior
 * for tool-usage guidance that's relevant whenever the user is asking
 * the agent to navigate code.
 */
const MDC_FRONTMATTER = [
  '---',
  'description: CodeGraph MCP usage guide — when to use which tool',
  'alwaysApply: true',
  'enabled: true',
  '---',
  '',
].join('\n');

const GLOBAL_NOTE =
  'If CodeBuddy IDE does not pick up CodeGraph automatically, open ' +
  'Settings → MCP and confirm `~/.codebuddy/mcp.json` is registered.';

class CodeBuddyTarget implements AgentTarget {
  readonly id = 'codebuddy' as const;
  readonly displayName = 'CodeBuddy IDE';
  readonly docsUrl = 'https://www.codebuddy.cn/docs/ide/User-guide/MCP';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;

    let installed: boolean;
    if (loc === 'global') {
      // CodeBuddy may be installed without `~/.codebuddy/` existing
      // until the user opens the IDE once. Any of these signals counts
      // as "present" — false positives are fine because the user can
      // deselect in the multiselect prompt.
      installed =
        fs.existsSync(userConfigDir()) ||
        fs.existsSync(mcpPath) ||
        fs.existsSync(path.join(userConfigDir(), 'settings.json')) ||
        fs.existsSync(path.join(userConfigDir(), 'models.json'));
    } else {
      installed =
        fs.existsSync(path.join(process.cwd(), '.codebuddy')) ||
        fs.existsSync(mcpPath) ||
        fs.existsSync(codebuddyMdPath()) ||
        fs.existsSync(agentsMdPath());
    }

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));
    files.push(writeInstructionsEntry(loc));

    const notes: string[] = [];
    if (loc === 'global') notes.push(GLOBAL_NOTE);

    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry — surgical removal of `mcpServers.codegraph`.
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      // If the file has nothing left, remove it entirely to keep the
      // user's dotfiles tidy. Otherwise re-serialize preserving siblings.
      if (Object.keys(config).length === 0) {
        try { fs.unlinkSync(mcpPath); } catch { /* ignore */ }
      } else {
        writeJsonFile(mcpPath, config);
      }
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Instructions.
    if (loc === 'global') {
      // We own `~/.codebuddy/rules/codegraph/RULE.mdc` outright — delete
      // the file entirely on uninstall, then drop the empty `codegraph/`
      // dir if it has no siblings.
      const file = userRulePath();
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        const ruleDir = path.dirname(file);
        try {
          const remaining = fs.readdirSync(ruleDir);
          if (remaining.length === 0) fs.rmdirSync(ruleDir);
        } catch { /* ignore */ }
        files.push({ path: file, action: 'removed' });
      } else {
        files.push({ path: file, action: 'not-found' });
      }
    } else {
      // For local instructions we strip the marker block from whichever
      // file the section currently lives in (`CODEBUDDY.md` or
      // `AGENTS.md`). Try `CODEBUDDY.md` first, then `AGENTS.md` — but
      // only the file actually containing the marker block is touched.
      const md = codebuddyMdPath();
      const agents = agentsMdPath();
      const candidate = sectionPresent(md) ? md : sectionPresent(agents) ? agents : md;
      const action = removeMarkedSection(
        candidate,
        CODEGRAPH_SECTION_START,
        CODEGRAPH_SECTION_END,
      );
      files.push({ path: candidate, action });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: getMcpServerConfig() } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }

  /**
   * Write the project-local `CODEBUDDY.md` marker block so a user who
   * ran `codegraph install --location=global` once doesn't have to
   * re-run it per project to get CodeBuddy to see CodeGraph's
   * instructions inside each workspace. The global `~/.codebuddy/mcp.json`
   * already covers MCP server config for every project, so we don't
   * force a project-level `.mcp.json` here.
   */
  wireProjectSurfaces(): WriteResult {
    return { files: [writeLocalInstructionsEntry()] };
  }
}

/** Helper for uninstall: detect the marker block on disk. */
function sectionPresent(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return (
      content.indexOf(CODEGRAPH_SECTION_START) !== -1 &&
      content.indexOf(CODEGRAPH_SECTION_END) !== -1
    );
  } catch {
    return false;
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before
    ? 'updated'
    : fs.existsSync(file)
      ? 'updated'
      : 'created';
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  return loc === 'global'
    ? writeGlobalRuleEntry()
    : writeLocalInstructionsEntry();
}

function writeGlobalRuleEntry(): WriteResult['files'][number] {
  const file = userRulePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const body = MDC_FRONTMATTER + INSTRUCTIONS_TEMPLATE;

  if (!fs.existsSync(file)) {
    atomicWriteFileSync(file, body + '\n');
    return { path: file, action: 'created' };
  }

  const existing = fs.readFileSync(file, 'utf-8');
  const wantWithNL = body + '\n';
  if (existing === wantWithNL) {
    return { path: file, action: 'unchanged' };
  }

  // The user may have edited the .mdc — preserve any user content
  // outside the marker block. The frontmatter on first install gets
  // re-emitted; on update, we leave whatever they have there untouched
  // and only swap the marker section.
  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

function writeLocalInstructionsEntry(): WriteResult['files'][number] {
  const file = resolveLocalInstructionsPath();
  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

export const codebuddyTarget: AgentTarget = new CodeBuddyTarget();
