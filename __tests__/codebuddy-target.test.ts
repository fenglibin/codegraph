/**
 * CodeBuddy IDE target — CodeBuddy-specific behaviors.
 *
 * The shared installer contract (idempotency, sibling preservation,
 * uninstall reverses install, printConfig writes nothing) is already
 * covered by the parameterized suite in `installer-targets.test.ts`
 * for every target including codebuddy. This file covers behaviors
 * specific to CodeBuddy: project-vs-user file paths, marker-block
 * preservation in pre-existing `CODEBUDDY.md`, the documented
 * `AGENTS.md` fallback when `CODEBUDDY.md` is absent, `.mdc`
 * frontmatter on the global user rule, sibling MCP server survival,
 * and `wireProjectSurfaces` behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getTarget, resolveTargetFlag } from '../src/installer/targets/registry';

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-codebuddy-${label}-`));
}

function setHome(dir: string): { restore: () => void } {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev.USERPROFILE;
    },
  };
}

describe('CodeBuddy target — CodeBuddy-specific behaviors', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  // --- Registry / target resolution ----------------------------------

  it('is registered in resolveTargetFlag("all")', () => {
    const targets = resolveTargetFlag('all', 'global');
    expect(targets.map((t) => t.id)).toContain('codebuddy');
  });

  it('resolveTargetFlag("codebuddy") returns just codebuddy', () => {
    const targets = resolveTargetFlag('codebuddy', 'global');
    expect(targets.map((t) => t.id)).toEqual(['codebuddy']);
  });

  // --- Global install -------------------------------------------------

  it('global install writes ~/.codebuddy/mcp.json + RULE.mdc and reports an advisory note', () => {
    const cb = getTarget('codebuddy')!;
    const result = cb.install('global', { autoAllow: false });

    const mcpFile = path.join(tmpHome, '.codebuddy', 'mcp.json');
    const ruleFile = path.join(tmpHome, '.codebuddy', 'rules', 'codegraph', 'RULE.mdc');

    expect(fs.existsSync(mcpFile)).toBe(true);
    expect(fs.existsSync(ruleFile)).toBe(true);

    const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(mcp.mcpServers.codegraph.command).toBe('codegraph');
    expect(mcp.mcpServers.codegraph.args).toEqual(['serve', '--mcp']);
    expect(mcp.mcpServers.codegraph.type).toBe('stdio');

    expect(result.notes?.length ?? 0).toBeGreaterThan(0);
    expect(result.notes!.join('\n')).toMatch(/Settings/i);

    expect(cb.detect('global').alreadyConfigured).toBe(true);
  });

  it('global RULE.mdc starts with .mdc frontmatter containing alwaysApply: true', () => {
    const cb = getTarget('codebuddy')!;
    cb.install('global', { autoAllow: false });
    const ruleFile = path.join(tmpHome, '.codebuddy', 'rules', 'codegraph', 'RULE.mdc');
    const body = fs.readFileSync(ruleFile, 'utf-8');

    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toMatch(/^alwaysApply:\s*true$/m);
    expect(body).toMatch(/^enabled:\s*true$/m);
    expect(body).toContain('<!-- CODEGRAPH_START -->');
    expect(body).toContain('<!-- CODEGRAPH_END -->');
    expect(body).toContain('codegraph_search');
  });

  // --- Local install: fresh project ----------------------------------

  it('local install writes ./.mcp.json + ./CODEBUDDY.md in a fresh project', () => {
    const cb = getTarget('codebuddy')!;
    const result = cb.install('local', { autoAllow: false });

    const mcpFile = path.join(tmpCwd, '.mcp.json');
    const mdFile = path.join(tmpCwd, 'CODEBUDDY.md');

    expect(fs.existsSync(mcpFile)).toBe(true);
    expect(fs.existsSync(mdFile)).toBe(true);

    const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(mcp.mcpServers.codegraph.command).toBe('codegraph');

    const md = fs.readFileSync(mdFile, 'utf-8');
    expect(md).toContain('<!-- CODEGRAPH_START -->');
    expect(md).toContain('<!-- CODEGRAPH_END -->');

    expect(result.notes?.length ?? 0).toBe(0);
  });

  // --- Local install: pre-existing CODEBUDDY.md ----------------------

  it('local install with pre-existing CODEBUDDY.md preserves all user content outside the marker block', () => {
    const cb = getTarget('codebuddy')!;
    const md = path.join(tmpCwd, 'CODEBUDDY.md');
    const original = [
      '# My project',
      '',
      'This is project-specific guidance from the user.',
      'It must survive intact.',
      '',
      '## A user section with code',
      '',
      '```bash',
      'echo hello',
      '```',
      '',
    ].join('\n');
    fs.writeFileSync(md, original);

    cb.install('local', { autoAllow: false });

    const after = fs.readFileSync(md, 'utf-8');
    expect(after).toContain('# My project');
    expect(after).toContain('This is project-specific guidance from the user.');
    expect(after).toContain('It must survive intact.');
    expect(after).toContain('## A user section with code');
    expect(after).toContain('echo hello');
    expect(after).toContain('<!-- CODEGRAPH_START -->');
    expect(after).toContain('codegraph_callers');
  });

  // --- AGENTS.md fallback --------------------------------------------

  it('local install writes into AGENTS.md when CODEBUDDY.md is absent and AGENTS.md exists', () => {
    const cb = getTarget('codebuddy')!;
    const agents = path.join(tmpCwd, 'AGENTS.md');
    fs.writeFileSync(agents, '# Project AGENTS guidance\n\nKeep this content.\n');

    cb.install('local', { autoAllow: false });

    expect(fs.existsSync(path.join(tmpCwd, 'CODEBUDDY.md'))).toBe(false);
    const body = fs.readFileSync(agents, 'utf-8');
    expect(body).toContain('# Project AGENTS guidance');
    expect(body).toContain('Keep this content.');
    expect(body).toContain('<!-- CODEGRAPH_START -->');
    expect(body).toContain('<!-- CODEGRAPH_END -->');
  });

  it('local install prefers CODEBUDDY.md when BOTH CODEBUDDY.md and AGENTS.md exist', () => {
    const cb = getTarget('codebuddy')!;
    const md = path.join(tmpCwd, 'CODEBUDDY.md');
    const agents = path.join(tmpCwd, 'AGENTS.md');
    fs.writeFileSync(md, '# CODEBUDDY.md content\n');
    fs.writeFileSync(agents, '# AGENTS.md content\n');

    cb.install('local', { autoAllow: false });

    const mdBody = fs.readFileSync(md, 'utf-8');
    const agentsBody = fs.readFileSync(agents, 'utf-8');
    expect(mdBody).toContain('<!-- CODEGRAPH_START -->');
    expect(agentsBody).not.toContain('CODEGRAPH_START');
    expect(agentsBody).toBe('# AGENTS.md content\n');
  });

  // --- Sibling MCP server preservation --------------------------------

  it('global install preserves a pre-existing sibling MCP server in ~/.codebuddy/mcp.json', () => {
    const cb = getTarget('codebuddy')!;
    const mcpFile = path.join(tmpHome, '.codebuddy', 'mcp.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(
      mcpFile,
      JSON.stringify(
        {
          mcpServers: {
            figma: {
              command: 'npx',
              args: ['@thirdstrandstudio/mcp-figma', '--figma-token', 'tok'],
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    cb.install('global', { autoAllow: false });

    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.figma).toBeDefined();
    expect(after.mcpServers.figma.command).toBe('npx');
    expect(after.mcpServers.codegraph).toBeDefined();
  });

  it('local install preserves a pre-existing sibling MCP server in ./.mcp.json', () => {
    const cb = getTarget('codebuddy')!;
    const mcpFile = path.join(tmpCwd, '.mcp.json');
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { tapd: { command: 'tapd-mcp', args: [] } } }, null, 2) + '\n',
    );

    cb.install('local', { autoAllow: false });

    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.tapd).toBeDefined();
    expect(after.mcpServers.codegraph).toBeDefined();
  });

  // --- Uninstall ------------------------------------------------------

  it('uninstall preserves sibling MCP servers and the rest of CODEBUDDY.md', () => {
    const cb = getTarget('codebuddy')!;

    // Seed: sibling MCP entry + user-authored CODEBUDDY.md.
    const mcpFile = path.join(tmpCwd, '.mcp.json');
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { tapd: { command: 'tapd-mcp', args: [] } } }, null, 2) + '\n',
    );
    const md = path.join(tmpCwd, 'CODEBUDDY.md');
    fs.writeFileSync(md, '# Personal project guidance\n\nKeep me.\n');

    cb.install('local', { autoAllow: false });
    cb.uninstall('local');

    // Sibling MCP entry preserved; codegraph removed.
    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.tapd).toBeDefined();
    expect(after.mcpServers.codegraph).toBeUndefined();

    // CODEBUDDY.md content preserved; marker block removed.
    const body = fs.readFileSync(md, 'utf-8');
    expect(body).toContain('# Personal project guidance');
    expect(body).toContain('Keep me.');
    expect(body).not.toContain('CODEGRAPH_START');
    expect(body).not.toContain('codegraph_callers');

    expect(cb.detect('local').alreadyConfigured).toBe(false);
  });

  it('uninstall deletes ~/.codebuddy/rules/codegraph/RULE.mdc file entirely', () => {
    const cb = getTarget('codebuddy')!;
    cb.install('global', { autoAllow: false });

    const ruleFile = path.join(tmpHome, '.codebuddy', 'rules', 'codegraph', 'RULE.mdc');
    expect(fs.existsSync(ruleFile)).toBe(true);

    cb.uninstall('global');

    expect(fs.existsSync(ruleFile)).toBe(false);
    // The empty rules/codegraph/ dir is also removed.
    expect(fs.existsSync(path.dirname(ruleFile))).toBe(false);
  });

  it('uninstall on never-installed state returns not-found cleanly without crashing', () => {
    const cb = getTarget('codebuddy')!;
    const result = cb.uninstall('global');
    expect(result.files.length).toBeGreaterThan(0);
    for (const f of result.files) {
      expect(['not-found', 'kept']).toContain(f.action);
    }
  });

  // --- wireProjectSurfaces -------------------------------------------

  it('wireProjectSurfaces writes only the local CODEBUDDY.md marker (no .mcp.json forced)', () => {
    const cb = getTarget('codebuddy')!;
    const result = cb.wireProjectSurfaces!();

    expect(result.files.length).toBe(1);
    expect(result.files[0].path.endsWith('CODEBUDDY.md')).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, 'CODEBUDDY.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '.mcp.json'))).toBe(false);
  });

  it('wireProjectSurfaces is idempotent on re-run', () => {
    const cb = getTarget('codebuddy')!;
    cb.wireProjectSurfaces!();
    const second = cb.wireProjectSurfaces!();
    expect(second.files[0].action).toBe('unchanged');
  });

  // --- Detection -----------------------------------------------------

  it('detect("local") reports installed=true when ./CODEBUDDY.md exists', () => {
    const cb = getTarget('codebuddy')!;
    expect(cb.detect('local').installed).toBe(false);
    fs.writeFileSync(path.join(tmpCwd, 'CODEBUDDY.md'), '# something\n');
    expect(cb.detect('local').installed).toBe(true);
  });

  it('detect("global") reports installed=true when ~/.codebuddy/settings.json exists', () => {
    const cb = getTarget('codebuddy')!;
    expect(cb.detect('global').installed).toBe(false);
    const dir = path.join(tmpHome, '.codebuddy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
    expect(cb.detect('global').installed).toBe(true);
  });

  // --- printConfig ---------------------------------------------------

  it('printConfig returns a parseable JSON snippet for global location', () => {
    const cb = getTarget('codebuddy')!;
    const out = cb.printConfig('global');
    expect(out).toContain('mcpServers');
    expect(out).toContain('"codegraph"');
    // Extract the JSON portion (after the `# Add to ...` header line).
    const jsonStart = out.indexOf('{');
    const parsed = JSON.parse(out.substring(jsonStart));
    expect(parsed.mcpServers.codegraph.command).toBe('codegraph');
  });

  it('printConfig writes no files', () => {
    const cb = getTarget('codebuddy')!;
    const before = fs.readdirSync(tmpHome).length;
    cb.printConfig('global');
    cb.printConfig('local');
    const after = fs.readdirSync(tmpHome).length;
    expect(after).toBe(before);
  });

  // --- describePaths -------------------------------------------------

  it('describePaths returns both MCP and instructions paths', () => {
    const cb = getTarget('codebuddy')!;
    const globalPaths = cb.describePaths('global');
    expect(globalPaths.length).toBe(2);
    expect(globalPaths.some((p) => p.endsWith('mcp.json'))).toBe(true);
    expect(globalPaths.some((p) => p.endsWith('RULE.mdc'))).toBe(true);

    const localPaths = cb.describePaths('local');
    expect(localPaths.length).toBe(2);
    expect(localPaths.some((p) => p.endsWith('.mcp.json'))).toBe(true);
    expect(localPaths.some((p) => /CODEBUDDY\.md|AGENTS\.md/.test(p))).toBe(true);
  });
});
