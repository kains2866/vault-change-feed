#!/usr/bin/env node
/**
 * vault-change-feed agent hook
 *
 * 会话启动时把 vault 的未读变更注入 AI 上下文，并推进本 reader 的游标。
 * 从会话 cwd 向上查找 `.obsidian/plugins/vault-change-feed/changelog.jsonl`，
 * 找不到（当前目录不在受跟踪的 vault 内）则静默退出，不产生任何输出。
 *
 * 用法（由 hook 配置调用，payload 经 stdin 传入）：
 *   node vault-feed-hook.mjs --reader=kimi-code --format=kimi
 *   node vault-feed-hook.mjs --reader=claude-code --format=claude
 *
 * --format=kimi   输出 {"message": "..."}（Kimi Code 从 message 读取文本）
 * --format=claude 输出 {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FEED_DIR = join('.obsidian', 'plugins', 'vault-change-feed');

function parseArgs() {
  const args = { reader: 'agent', format: 'kimi' };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--reader=')) args.reader = a.slice('--reader='.length);
    if (a.startsWith('--format=')) args.format = a.slice('--format='.length);
  }
  return args;
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** 从 dir 向上找包含 feed 的 vault 根；找不到返回 null */
function findVault(dir) {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, FEED_DIR, 'changelog.jsonl'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function readCursors(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function parseLog(content) {
  const events = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (typeof e.seq === 'number' && typeof e.op === 'string' && typeof e.path === 'string') {
        events.push(e);
      }
    } catch {
      // 坏行跳过
    }
  }
  return events;
}

/** 与插件 merge.ts 相同的合并规则（保持两处语义一致） */
function mergeEvents(events) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const groups = new Map();
  const out = [];
  for (const e of sorted) {
    if (e.op === 'resync') {
      out.push(e);
      continue;
    }
    const g = groups.get(e.path);
    if (g) g.push(e);
    else groups.set(e.path, [e]);
  }
  const sumStats = (g) => {
    let added = 0;
    let removed = 0;
    for (const e of g) {
      if (e.stat === null) return null;
      added += e.stat.added;
      removed += e.stat.removed;
    }
    return { added, removed };
  };
  for (const g of groups.values()) {
    const first = g[0];
    const last = g[g.length - 1];
    if (first.op === 'create' && last.op === 'delete') continue; // 窗口内建了又删
    const firstRename = g.find((e) => e.op === 'rename');
    const deleteCount = g.reduce((n, e) => n + (e.op === 'delete' ? 1 : 0), 0);
    const base = {
      seq: Math.max(...g.map((e) => e.seq)),
      ts: Math.max(...g.map((e) => e.ts)),
      source: last.source,
    };
    if (last.op === 'delete' && firstRename && deleteCount === 1) {
      out.push({ ...base, op: 'delete', path: firstRename.oldPath ?? first.path, stat: last.stat });
    } else if (firstRename && deleteCount > 0) {
      out.push(...g); // delete 与 rename 交织，拒合并
    } else if (last.op === 'delete') {
      out.push({ ...base, op: 'delete', path: first.path, stat: last.stat });
    } else if (deleteCount > 0) {
      out.push({ ...base, op: 'modify', path: first.path, stat: null }); // 删了又建
    } else if (first.op === 'create') {
      out.push({ ...base, op: 'create', path: first.path, stat: sumStats(g) });
    } else if (firstRename) {
      out.push({
        ...base,
        op: 'rename',
        path: first.path,
        oldPath: firstRename.oldPath,
        stat: sumStats(g),
      });
    } else {
      out.push({ ...base, op: 'modify', path: first.path, stat: sumStats(g) });
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

function formatEvent(e) {
  const stat = e.stat ? ` +${e.stat.added}/-${e.stat.removed}` : '';
  if (e.op === 'rename') return `rename ${e.oldPath} → ${e.path}`;
  if (e.op === 'resync') return 'resync — baseline rebuilt; full vault rescan advised';
  return `${e.op}${stat} ${e.path}`;
}

function main() {
  const { reader, format } = parseArgs();
  const payload = readStdin();
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();

  const vault = findVault(cwd);
  if (!vault) process.exit(0); // 不在受跟踪 vault 内：静默

  const feedDir = join(vault, FEED_DIR);
  const logPath = join(feedDir, 'changelog.jsonl');
  const cursorsPath = join(feedDir, 'cursors.json');

  const cursors = readCursors(cursorsPath);
  const cursor = cursors[reader] ?? 0;
  const events = parseLog(readFileSync(logPath, 'utf8'));
  const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
  const unread = events.filter((e) => e.seq > cursor);
  if (unread.length === 0) process.exit(0); // 无未读：静默

  const minSeq = Math.min(...events.map((e) => e.seq));
  const stale = cursor > 0 && minSeq > cursor + 1;

  // 推进游标（事件已注入上下文，视为已读）：只改自己的 key，原子写
  cursors[reader] = maxSeq;
  writeFileSync(cursorsPath + '.tmp', JSON.stringify(cursors, null, 2));
  renameSync(cursorsPath + '.tmp', cursorsPath);

  const lines = [];
  lines.push(
    `[vault-change-feed] ${unread.length} change event(s) in this vault since your last visit (reader: ${reader}). The user made these edits — account for them before managing notes.`,
  );
  if (stale) {
    lines.push('WARNING: log was rotated and you missed events — do a FULL vault rescan instead of trusting this list.');
  }
  for (const e of mergeEvents(unread)) lines.push(formatEvent(e));
  lines.push('stat +A/-R = lines added/removed; null = open the file to see. Full protocol: the vault-change-feed block in AGENTS.md.');
  const text = lines.join('\n');

  if (format === 'claude') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      }),
    );
  } else {
    process.stdout.write(JSON.stringify({ message: text }));
  }
}

main();
