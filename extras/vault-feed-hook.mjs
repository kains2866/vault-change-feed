#!/usr/bin/env node
/**
 * vault-change-feed agent hook (v2 分设备日志)
 *
 * 会话启动时把 vault 的未读变更注入 AI 上下文，并推进本 reader 的游标。
 * 从会话 cwd 向上查找 vault（先探测默认配置目录 `.obsidian`，未命中则逐个探测
 * vault 根下的其他目录——兼容自定义 configDir 的 vault），
 * 找不到（当前目录不在受跟踪的 vault 内）则静默退出，不产生任何输出。
 *
 * v2 读取语义：每设备独立 events/<deviceId>.jsonl（各自 seq），游标按设备记于
 * cursors/<reader>.json；跨设备排序 (ts,device,seq) + (path,op,ch) 内容去重；
 * 同文件仍可合并为累计变更。
 *
 * 用法（由 hook 配置调用，payload 经 stdin 传入）：
 *   node vault-feed-hook.mjs --reader=kimi-code --format=kimi
 *   node vault-feed-hook.mjs --reader=claude-code --format=claude
 *
 * --format=kimi   输出 {"message": "..."}（Kimi Code 从 message 读取文本）
 * --format=claude 输出 {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
 * --max-events=N  单次注入的合并事件数上限（默认 200）。超限只注入前 N 条，
 *                 各设备游标只推进到已注入的最后一条（部分消费），剩余下次会话继续。
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// 同文件合并规则单源（src/core/merge.ts），由 esbuild 生成此运行时产物；勿手改本文件
import { mergeEvents } from './merge-runtime.mjs';

const DEFAULT_CONFIG_DIR = '.obsidian';
const PLUGIN_ID = 'vault-change-feed';
const DEFAULT_MAX_EVENTS = 200;

function safeKey(id, fallback) {
  const k = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  return k.length > 0 ? k : fallback;
}

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

/** configDir 下插件数据目录是否存在（manifest/devices/changelog 任一命中即认为已安装使用） */
function isFeedDir(root, configDir) {
  const dir = join(root, configDir, 'plugins', PLUGIN_ID);
  return (
    existsSync(join(dir, 'manifest.json')) ||
    existsSync(join(dir, 'devices.json')) ||
    existsSync(join(dir, 'changelog.jsonl'))
  );
}

/**
 * 从 dir 向上查找 vault 根与配置目录；找不到返回 null。
 * 候选顺序：默认 `.obsidian` 优先，其后 vault 根下的目录项按字典序探测。
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
      if (name === DEFAULT_CONFIG_DIR) continue;
      if (isFeedDir(cur, name)) return { vault: cur, configDir: name };
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** 容错读 JSON 对象（仅保留数值成员 → map） */
function readNumberMap(path) {
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

/** devices.json → 设备 id 列表 */
function readDeviceIds(feedDir) {
  try {
    const obj = JSON.parse(readFileSync(join(feedDir, 'devices.json'), 'utf8'));
    if (obj === null || typeof obj !== 'object' || !Array.isArray(obj.devices)) return [];
    return obj.devices
      .filter(d => d && typeof d.id === 'string')
      .map(d => d.id);
  } catch {
    return [];
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

/** 跨设备内容去重（同 (path,op,ch) 只保留最早一条） */
function dedupeByContent(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if ((e.op === 'create' || e.op === 'modify') && typeof e.ch === 'string' && e.ch.length > 0) {
      const key = `${e.path}|${e.op}|${e.ch}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(e);
  }
  return out;
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
  const readerKey = safeKey(reader, 'reader');
  const cursorPath = join(feedDir, 'cursors', `${readerKey}.json`);

  const cursors = readNumberMap(cursorPath); // {deviceId: lastSeq}
  const deviceIds = readDeviceIds(feedDir);

  // 收集各设备未读
  const unread = [];
  const perDeviceMax = {}; // 本次读取各设备日志最大 seq
  const staleDevices = [];
  for (const dev of deviceIds) {
    const file = join(feedDir, 'events', `${safeKey(dev, 'device')}.jsonl`);
    if (!existsSync(file)) continue;
    const evs = parseLog(readFileSync(file, 'utf8')).map(e => ({
      ...e,
      device: typeof e.device === 'string' ? e.device : dev,
    }));
    if (evs.length === 0) continue;
    const seqs = evs.map(e => e.seq);
    const minSeq = Math.min(...seqs);
    const maxSeq = Math.max(...seqs);
    perDeviceMax[dev] = maxSeq;
    const cursor = cursors[dev] ?? 0;
    for (const e of evs) if (e.seq > cursor) unread.push(e);
    if (cursor > 0 && minSeq > cursor + 1) staleDevices.push(dev);
  }
  if (unread.length === 0) process.exit(0); // 无未读：静默

  // 跨设备排序 + ch 去重 + 同文件合并
  unread.sort((a, b) => a.ts - b.ts || a.device.localeCompare(b.device) || a.seq - b.seq);
  const deduped = dedupeByContent(unread);
  const merged = mergeEvents(deduped);

  const cap = maxEvents;
  const truncated = merged.length > cap;
  const injected = truncated ? merged.slice(0, cap) : merged;

  // 部分消费：各设备游标只推进到已注入事件里该设备的 max seq
  const delivered = {};
  for (const e of injected) {
    const d = e.device;
    if (d) delivered[d] = Math.max(delivered[d] ?? 0, e.seq);
  }
  const nextCursors = { ...cursors };
  let changed = false;
  if (truncated) {
    for (const [d, s] of Object.entries(delivered)) {
      if ((nextCursors[d] ?? 0) < s) {
        nextCursors[d] = s;
        changed = true;
      }
    }
  } else {
    for (const d of Object.keys(perDeviceMax)) {
      if ((nextCursors[d] ?? 0) < perDeviceMax[d]) {
        nextCursors[d] = perDeviceMax[d];
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(cursorPath + '.tmp', JSON.stringify(nextCursors, null, 2));
    renameSync(cursorPath + '.tmp', cursorPath);
  }

  const remaining = truncated
    ? unread.filter(e => (nextCursors[e.device] ?? 0) < e.seq).length
    : 0;

  const lines = [];
  lines.push(
    `[vault-change-feed] ${unread.length} change event(s) across ${deviceIds.length} device(s) since your last visit (reader: ${reader}). The user made these edits — account for them before managing notes.`,
  );
  if (staleDevices.length > 0) {
    lines.push(
      `WARNING: log(s) of device(s) ${staleDevices.join(', ')} were rotated and you missed events — do a FULL vault rescan instead of trusting this list.`,
    );
  }
  for (const e of injected) lines.push(formatEvent(e));
  if (remaining > 0) {
    lines.push(
      `…and ${remaining} more change event(s) remain unread (cap ${cap}); rerun this hook or read the device logs directly to consume them.`,
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
