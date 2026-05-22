## ADDED Requirements

### Requirement: Bilingual Agent Instructions Template

The shared `INSTRUCTIONS_TEMPLATE` written by every `AgentTarget` into its agent's conventional instructions file (CLAUDE.md / AGENTS.md / codegraph.mdc / CODEBUDDY.md / RULE.mdc) SHALL contain both an English section and a Chinese mirror section inside the existing marker pair. The Chinese mirror SHALL include the same structural content as the English section (mandatory rules, when-to-prefer-codegraph guidance, rules of thumb, fallback prompt) so non-Claude models reading their conventional instructions file in their training-language register also encounter the codegraph playbook in usable form. The marker pair `<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->` SHALL remain byte-identical across the bilingual rewrite — five installers (claude, cursor, codex, opencode, codebuddy) detect and replace the section by exact marker match. The bilingual template SHALL stay within a per-project budget of 8000 characters so the additive weight of the Chinese mirror does not balloon every agent file.

#### Scenario: Marker strings unchanged after bilingual rewrite
- **WHEN** the `INSTRUCTIONS_TEMPLATE` constant is read
- **THEN** it begins with the literal `<!-- CODEGRAPH_START -->`
- **AND** ends with the literal `<!-- CODEGRAPH_END -->`
- **AND** each marker appears exactly once (no nesting, no duplication)

#### Scenario: English section preserved verbatim
- **WHEN** the bilingual template is rendered
- **THEN** the English section retains the `codegraph_callers`,
  `codegraph_explore`, `codegraph_status` tool references that the
  existing installer-targets test suite asserts
- **AND** retains the "If `.codegraph/` doesn't exist" fallback prompt
  with the `codegraph init -i` command verbatim

#### Scenario: Chinese mirror section follows English with own heading
- **WHEN** the template is read
- **THEN** it contains a `## CodeGraph（中文）` heading after the
  English `## CodeGraph` heading
- **AND** the index of `## CodeGraph（中文）` is strictly greater than
  the index of `## CodeGraph\n` (English first, Chinese mirror after)

#### Scenario: Chinese mandatory rules block contains 5 绝不 rules
- **WHEN** the template is read
- **THEN** it contains the literal `🚫 强制规则`
- **AND** contains at least 5 instances of `**绝不**` (one per rule)
- **AND** mentions `DeepSeek、Qwen、GLM` (allowing line wraps via
  dot-all matching since Chinese commas wrap at column 80)

#### Scenario: Bilingual drift guard for low-confidence threshold
- **WHEN** the template is read
- **THEN** the English section contains the literal `confidence < 0.7`
- **AND** the Chinese section contains the literal `置信度 < 0.7`

#### Scenario: Bilingual drift guard for index-age threshold
- **WHEN** the template is read
- **THEN** the English section contains the literal `over 30 minutes`
- **AND** the Chinese section contains the literal `30 分钟`

#### Scenario: Template length within reasonable budget
- **WHEN** the template is read
- **THEN** its character length is greater than 3000 (Chinese mirror
  cannot be silently deleted)
- **AND** less than 8000 (future edits cannot drift into runaway prose)

#### Scenario: Idempotent re-install survives bilingual rewrite
- **WHEN** any of the 5 installer targets (claude, cursor, codex,
  opencode, codebuddy) runs `install()` twice with the same inputs
- **THEN** every file in the second call's `WriteResult.files` has
  `action='unchanged'`
- **AND** on-disk content is byte-identical to the first call
- **AND** the previously-passing 84 cases in `installer-targets.test.ts`
  continue to pass with no test modification
