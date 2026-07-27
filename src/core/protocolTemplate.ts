import { BLOCK_START, BLOCK_END } from './protocolBlock';

/** 写入 AGENTS.md / CLAUDE.md 的完整标记块（含标记行）；英文，面向所有 agent */
export function renderProtocolBlock(): string {
  return `${BLOCK_START}
## Vault change feed (vault-change-feed plugin)

This vault is tracked by the **vault-change-feed** Obsidian plugin. Before editing notes, catch up on what changed since your last visit:

1. Read \`.obsidian/plugins/vault-change-feed/cursors.json\` and find your reader name — you MUST use one stable id forever (e.g. your agent's name, like "claude-code"); absent means cursor 0.
2. Read \`.obsidian/plugins/vault-change-feed/changelog.jsonl\` (one JSON event per line) and take events with \`seq\` greater than your cursor.
   - If your cursor is > 0 and the smallest \`seq\` in the file is greater than cursor + 1, the log was rotated — you MUST do a full vault rescan instead.
   - An event with \`op: "resync"\` means the plugin rebuilt its baseline — do a full rescan.
   - \`stat: null\` means "changed, magnitude unknown" — open the file if you care.
   - Multiple events for the same file can be read as one cumulative change (a later \`delete\` wins; a \`rename\` means the path changed).
3. After processing, update \`cursors.json\`: read it, change ONLY your own reader key (keep every other reader's entry unchanged), and write it back — you MUST write \`cursors.json.tmp\` first, then rename it to \`cursors.json\`. NEVER write \`cursors.json\` directly.
   - Never write a cursor larger than the largest \`seq\` actually present in the log you read.
   - If anything looks inconsistent (gap, resync, files mentioned that don't exist), do a full vault rescan instead of trusting the feed.

Event shape: \`{"seq", "ts", "op": "create"|"modify"|"delete"|"rename"|"resync", "path", "oldPath"?, "stat": {"added", "removed"} | null, "source"}\`.
${BLOCK_END}`;
}
