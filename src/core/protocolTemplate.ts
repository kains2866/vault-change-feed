import { BLOCK_START, BLOCK_END } from './protocolBlock';

/** 写入 AGENTS.md / CLAUDE.md 的完整标记块（含标记行）；英文，面向所有 agent。
 *  configDir 来自 vault.configDir（默认为 .obsidian，用户可自定义）。
 *  v2：每设备独立日志 + 每 reader 独立游标文件 + (path, op, ch) 内容去重。 */
export function renderProtocolBlock(configDir: string): string {
  const feed = `${configDir}/plugins/vault-change-feed`;
  return `${BLOCK_START}
## Vault change feed (vault-change-feed plugin, v2)

This vault is tracked by the **vault-change-feed** Obsidian plugin. Every device that edits this vault appends to its OWN log (independent \`seq\` per device) — there is no shared sequence. Before editing notes, catch up on what changed since your last visit:

1. Read \`${feed}/cursors/<reader>.json\` — your reader file. It maps \`{deviceId: lastSeq}\`. Use ONE stable reader id forever (e.g. your agent's name, like "claude-code"); absent file means cursor 0 for every device. Write ONLY your own file, never anyone else's.
2. Read \`${feed}/devices.json\` → \`devices[].id\` is every known writing device.
3. For each device, read \`${feed}/events/<deviceId>.jsonl\` (one JSON event per line) and take events with \`seq\` greater than your cursor for THAT device.
   - If that device's cursor is > 0 and its smallest \`seq\` in the file is greater than cursor + 1, that log was rotated — you MUST do a full vault rescan instead.
   - An event with \`op: "resync"\` means the baseline was rebuilt — do a full rescan.
   - \`stat: null\` means "changed, magnitude unknown" — open the file if you care.
4. Merge what you read into one timeline: sort by (\`ts\`, \`device\`, \`seq\`). Then drop duplicates: for \`create\`/\`modify\` events carrying a content hash \`ch\`, keep only the FIRST event with a given (\`path\`, \`op\`, \`ch\`) — the same physical change may be recorded by more than one device.
   - Multiple events for the same file can still be read as one cumulative change (a later \`delete\` wins; a \`rename\` means the path changed).
5. After processing, write your cursor file \`${feed}/cursors/<reader>.json\` as \`{deviceId: largestSeqSeen}\` per device — write \`<file>.tmp\` first, then rename it over the file. Never write a cursor larger than the largest \`seq\` you actually read for that device.
   - If anything looks inconsistent (gap, resync, missing files), do a full vault rescan instead of trusting the feed.

Event shape: \`{"device", "seq", "ts", "op": "create"|"modify"|"delete"|"rename"|"resync", "path", "oldPath"?, "ch": "contentHash"|null, "stat": {"added", "removed"} | null, "source"}\` (\`ch\` only meaningful for \`create\`/\`modify\`; legacy rows may lack it).
${BLOCK_END}`;
}
