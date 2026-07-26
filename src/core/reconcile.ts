import { Baseline, BaselineEntry, countLines } from './baseline';
import { lineStat } from './diff';
import { ChangeEvent } from './types';

export interface FileSnapshot {
  path: string;
  /** 文本：hashContent(content)；二进制/大文件：binaryHash(size, mtime) */
  hash: string;
  content: string | null;
  mtime: number;
}

export function reconcile(
  oldBaseline: Baseline,
  current: FileSnapshot[],
  startSeq: number,
  scanTs: number,
): { events: ChangeEvent[]; baseline: Baseline } {
  const raw: Array<Omit<ChangeEvent, 'seq'>> = [];
  const currentMap = new Map(current.map(f => [f.path, f]));

  const deleted: string[] = [];
  for (const oldPath of oldBaseline.keys()) {
    if (!currentMap.has(oldPath)) deleted.push(oldPath);
  }

  const created: FileSnapshot[] = [];
  for (const f of current) {
    const old = oldBaseline.get(f.path);
    if (!old) {
      created.push(f);
    } else if (old.hash !== f.hash) {
      const stat =
        old.content !== null && f.content !== null ? lineStat(old.content, f.content) : null;
      raw.push({ ts: f.mtime, op: 'modify', path: f.path, stat, source: 'reconcile' });
    }
  }

  // rename 配对：同一次对账中 delete + create 且内容 hash 相同
  const createByHash = new Map<string, FileSnapshot[]>();
  for (const f of created) {
    const arr = createByHash.get(f.hash) ?? [];
    arr.push(f);
    createByHash.set(f.hash, arr);
  }
  const pairedNew = new Set<string>();
  const pairedOld = new Set<string>();
  for (const oldPath of deleted) {
    const oldHash = oldBaseline.get(oldPath)!.hash;
    const cand = (createByHash.get(oldHash) ?? []).find(f => !pairedNew.has(f.path));
    if (cand) {
      pairedNew.add(cand.path);
      pairedOld.add(oldPath);
      raw.push({
        ts: cand.mtime, op: 'rename', path: cand.path, oldPath: oldPath,
        stat: { added: 0, removed: 0 }, source: 'reconcile',
      });
    }
  }

  for (const oldPath of deleted) {
    if (pairedOld.has(oldPath)) continue;
    const old = oldBaseline.get(oldPath)!;
    const stat = old.content !== null ? { added: 0, removed: countLines(old.content) } : null;
    raw.push({ ts: scanTs, op: 'delete', path: oldPath, stat, source: 'reconcile' });
  }
  for (const f of created) {
    if (pairedNew.has(f.path)) continue;
    const stat = f.content !== null ? { added: countLines(f.content), removed: 0 } : null;
    raw.push({ ts: f.mtime, op: 'create', path: f.path, stat, source: 'reconcile' });
  }

  raw.sort((a, b) => a.ts - b.ts || a.path.localeCompare(b.path));
  let seq = startSeq;
  const events = raw.map(e => ({ ...e, seq: seq++ }));

  const baseline: Baseline = new Map<string, BaselineEntry>(
    current.map(f => [f.path, { hash: f.hash, content: f.content }]),
  );
  return { events, baseline };
}
