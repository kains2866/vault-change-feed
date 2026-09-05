#!/usr/bin/env node
/**
 * vault-change-feed agent hook
 *
 * 会话启动时把 vault 的未读变更注入 AI 上下文，并推进本 reader 的游标。
 * 从会话 cwd 向上查找 vault（先探测默认配置目录 `.obsidian`，未命中则逐个探测
 * vault 根下的其他目录——兼容自定义 configDir 的 vault，见插件 1.1.1+），
 * 找不到（当前目录不在受跟踪的 vault 内）则静默退出，不产生任何输出。
 *
 * 用法（由 hook 配置调用，payload 经 stdin 传入）：
 *   node vault-feed-hook.mjs --reader=kimi-code --format=kimi
 *   node vault-feed-hook.mjs --reader=claude-code --format=claude
 *
 * --format=kimi   输出 {"message": "..."}（Kimi Code 从 message 读取文本）
 * --format=claude 输出 {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
 * --max-events=N  单次注入的合并事件数上限（默认 200）。超限时只注入前 N 条，
 *                 游标仅推进到已注入的最后一条（部分消费），剩余下次会话继续，
 *                 避免长间隔后输出超时被丢弃导致变更静默丢失。
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// 合并规则单源（src/core/merge.ts），由 esbuild 生成此运行时产物；勿手改本文件
import { mergeEvents } from './merge-runtime.mjs';

const DEFAULT_CONFIG_DIR = '.obsidian';
const PLUGIN_ID = 'vault-change-feed';
const DEFAULT_MAX_EVENTS = 200;

function parseArgs() {
  const args = { reader: 'agent', format: 'kimi', maxEvents: DEFAULT_MAX_EVENTS };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--reader=')) args.reader = a.slice('--reader='.length);
    if (a.startsWith('--format=')) args.format = a.slice('--format='.length);
    if (a.startsWith('--max-events=')) {
      const n = Number(a.slice('--max-events='.length));
      if (Number.isFinite(n) && n >= 1) args.maxEvents = Math.floor(n);
    }
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

/** configDir 下插件数据目录是否存在（manifest 或 changelog 任一命中即认为已安装使用） */
function isFeedDir(root, configDir) {
  const dir = join(root, configDir, 'plugins', PLUGIN_ID);
  return existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, 'changelog.jsonl'));
}

/**
 * 从 dir 向上查找 vault 根与配置目录；找不到返回 null。
 * 候选顺序：默认 `.obsidian` 优先，其后 vault 根下的目录项按字典序探测，
 * 取第一个包含插件数据目录的候选（同一 vault 一般只有一个配置目录）。
 */
function findVault(dir) {
  let cur = dir;
  for (;;) {
    if (isFeedDir(cur, DEFAULT_CONFIG_DIR)) return { vault: cur, configDir: DEFAULT_CONFIG_DIR };
    let entries = [];
    try {
      entries = readdirSync(cur, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.' && d.name !== '..')
        .map(d => d.name)
        .sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name === DEFAULT_CONFIG_DIR) continue; // 已探测过
      if (isFeedDir(cur, name)) return { vault: cur, configDir: name };
    }
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

function formatEvent(e) {
  const stat = e.stat ? ` +${e.stat.added}/-${e.stat.removed}` : '';
  if (e.op === 'rename') return `rename ${e.oldPath} → ${e.path}`;
  if (e.op === 'resync') return 'resync — baseline rebuilt; full vault rescan advised';
  return `${e.op}${stat} ${e.path}`;
}

function main() {
  const { reader, format, maxEvents } = parseArgs();
  const payload = readStdin();
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();

  const found = findVault(cwd);
  if (!found) process.exit(0); // 不在受跟踪 vault 内：静默

  const feedDir = join(found.vault, found.configDir, 'plugins', PLUGIN_ID);
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

  // 合并 + 注入上限：超限只注入前 N 条，游标只推进到已注入的最后一条（部分消费），
  // 剩余下次会话继续——防止长间隔后单次输出超时被丢弃导致变更静默丢失
  const merged = mergeEvents(unread);
  const cap = maxEvents;
  const truncated = merged.length > cap;
  const injected = truncated ? merged.slice(0, cap) : merged;
  // 全部事件被窗口合并丢弃（如建了又删）时也推进到 maxSeq，避免死循环重读
  const advanceSeq =
    injected.length > 0 ? injected[injected.length - 1].seq : truncated ? 0 : maxSeq;
  const rawRemaining = truncated ? unread.filter((e) => e.seq > advanceSeq).length : 0;

  // 推进游标（已注入事件视为已读）：只改自己的 key，原子写
  cursors[reader] = Math.max(cursor, advanceSeq);
  writeFileSync(cursorsPath + '.tmp', JSON.stringify(cursors, null, 2));
  renameSync(cursorsPath + '.tmp', cursorsPath);

  const lines = [];
  lines.push(
    `[vault-change-feed] ${unread.length} change event(s) in this vault since your last visit (reader: ${reader}). The user made these edits — account for them before managing notes.`,
  );
  if (stale) {
    lines.push('WARNING: log was rotated and you missed events — do a FULL vault rescan instead of trusting this list.');
  }
  for (const e of injected) lines.push(formatEvent(e));
  if (rawRemaining > 0) {
    lines.push(
      `…and ${rawRemaining} more change event(s) remain unread (cap ${cap}); rerun this hook or read the changelog directly to consume them.`,
    );
  }
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
