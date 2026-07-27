import { ChangeEvent, LineStat } from './types';

/** 全部 stat 非 null 则逐项累加，否则 null */
function sumStats(group: ChangeEvent[]): LineStat | null {
  let added = 0;
  let removed = 0;
  for (const e of group) {
    if (e.stat === null) return null;
    added += e.stat.added;
    removed += e.stat.removed;
  }
  return { added, removed };
}

/**
 * 合并一个 path 分组（组内按 seq 升序）；返回合并后的事件数组：
 * 空数组 = 整组丢弃；多条 = 组内信息不可无损合并，原样输出。
 * 判定顺序与任务规则表一致：
 * 1. 首 create 且尾 delete → 窗口内建了又删，读者从未见过，丢弃
 * 2. 尾 delete 且组内含 rename → delete，path 取首个 rename 的 oldPath
 *    （读者只知道旧名，落在旧名上才读得懂），不带 oldPath 字段，stat 取最后一条 delete 自身
 * 3. 组内同时含 delete 与 rename（非 2 情形）→ 任何合并都会丢某个路径的命运，拒合并，原样输出
 * 4. 尾 delete → delete（stat 取最后一条 delete 自身，即文件删除时的行数）
 * 5. 组内有 delete 但其后有 create（删了又建，文件仍在）→ modify，stat null
 * 6. 首 create（文件仍在）→ create，stat 累加
 * 7. 组内有 rename（文件仍在）→ rename（保留首个 rename 的 oldPath），stat 累加
 * 8. 其余（纯 modify）→ modify，stat 累加
 */
function mergeGroup(group: ChangeEvent[]): ChangeEvent[] {
  const first = group[0];
  const last = group[group.length - 1];

  if (first.op === 'create' && last.op === 'delete') return [];

  const firstRename = group.find(e => e.op === 'rename');

  if (last.op === 'delete' && firstRename) {
    return [
      {
        seq: Math.max(...group.map(e => e.seq)),
        ts: Math.max(...group.map(e => e.ts)),
        op: 'delete',
        path: firstRename.oldPath ?? first.path,
        stat: last.stat,
        source: last.source,
      },
    ];
  }

  if (firstRename && group.some(e => e.op === 'delete')) return group;

  let op: ChangeEvent['op'];
  let stat: LineStat | null;
  let oldPath: string | undefined;

  if (last.op === 'delete') {
    op = 'delete';
    stat = last.stat;
  } else if (group.some(e => e.op === 'delete')) {
    op = 'modify';
    stat = null;
  } else if (first.op === 'create') {
    op = 'create';
    stat = sumStats(group);
  } else if (firstRename) {
    op = 'rename';
    oldPath = firstRename.oldPath;
    stat = sumStats(group);
  } else {
    op = 'modify';
    stat = sumStats(group);
  }

  const merged: ChangeEvent = {
    seq: Math.max(...group.map(e => e.seq)),
    ts: Math.max(...group.map(e => e.ts)),
    op,
    path: first.path,
    stat,
    source: last.source,
  };
  if (op === 'rename' && oldPath !== undefined) merged.oldPath = oldPath;
  return [merged];
}

/**
 * 读取侧合并：同一文档的连续事件合并为一条，降低读者噪音。
 * 输入无需有序（先按 seq 排序副本再分组——flush 失败重入队可能乱序）；
 * resync 不合并、原样保留；输出按合并后 seq 升序。纯函数，不改输入。
 */
export function mergeEvents(events: ChangeEvent[]): ChangeEvent[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, ChangeEvent[]>();
  const out: ChangeEvent[] = [];
  for (const e of sorted) {
    if (e.op === 'resync') {
      out.push(e);
      continue;
    }
    const g = groups.get(e.path);
    if (g) g.push(e);
    else groups.set(e.path, [e]);
  }
  for (const g of groups.values()) {
    out.push(...mergeGroup(g));
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
