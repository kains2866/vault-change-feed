import { BLOCK_START, BLOCK_END } from './protocolBlock';

/** 写入 AGENTS.md / CLAUDE.md 的完整标记块（含标记行）；英文，面向所有 agent */
export function renderProtocolBlock(): string {
  return `${BLOCK_START}
## Vault change feed (vault-change-feed plugin)

This vault is tracked by the **vault-change-feed** Obsidian plugin. Before editing notes, catch up on what changed since your last visit:

1. Read \`.obsidian/plugins/vault-change-feed/cursors.json\` and find your reader name (use your own agent id, e.g. "claude-code"; absent means cursor 0).
2. Read \`.obsidian/plugins/vault-change-feed/changelog.jsonl\` (one JSON event per line) and take events with \`seq\` greater than your cursor.
   - If your cursor is > 0 and the smallest \`seq\` in the file is greater than cursor + 1, the log was rotated — do a full vault rescan instead.
   - An event with \`op: "resync"\` means the plugin rebuilt its baseline — full rescan advised.
   - \`stat: null\` means "changed, magnitude unknown" — open the file if you care.
   - Multiple events for the same file can be read as one cumulative change.
3. After processing, write the largest \`seq\` you saw back to \`cursors.json\` under your reader name — atomically: write \`cursors.json.tmp\`, then rename it to \`cursors.json\`.

Event shape: \`{"seq", "ts", "op": "create"|"modify"|"delete"|"rename"|"resync", "path", "oldPath"?, "stat": {"added", "removed"} | null, "source"}\`.
${BLOCK_END}`;
}
