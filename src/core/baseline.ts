import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { hashContent, binaryHash } from './hash';

export interface BaselineEntry {
  hash: string;
  /** 文本文件为全文；二进制/大文件为 null */
  content: string | null;
  /** 记录时的文件字节数（可选，用于启动预筛跳过未变文件；旧格式缺失则必读） */
  size?: number;
  /** 记录时的文件 mtime（可选，同上） */
  mtime?: number;
}

export type Baseline = Map<string, BaselineEntry>;

/** 附带 size/mtime 元信息（有则记，供启动预筛复用） */
function attachMeta(e: BaselineEntry, size?: number, mtime?: number): BaselineEntry {
  if (size !== undefined && mtime !== undefined) {
    e.size = size;
    e.mtime = mtime;
  }
  return e;
}

export function makeTextEntry(content: string, size?: number, mtime?: number): BaselineEntry {
  return attachMeta({ hash: hashContent(content), content }, size, mtime);
}

/**
 * 预算内存全文：超预算只存哈希（变更检测仍精确，diff 退化为 stat null）。返回新 entry。
 * usedBytes 为当前基线已占用的内容字节数（见 entryContentBytes）。
 * size/mtime 无论是否存全文都会记录，保证下次启动可做 stat 预筛。
 */
export function makeTextEntryBudgeted(
  content: string,
  usedBytes: number,
  budgetBytes: number,
  size?: number,
  mtime?: number,
): BaselineEntry {
  if (usedBytes + content.length * 2 > budgetBytes) {
    return attachMeta({ hash: hashContent(content), content: null }, size, mtime);
  }
  return makeTextEntry(content, size, mtime);
}

/** entry 全文占用的估算字节数（UTF-16 码元 × 2）；无全文为 0 */
export function entryContentBytes(e: BaselineEntry): number {
  return e.content === null ? 0 : e.content.length * 2;
}

/**
 * 启动预筛：文本条目且 size/mtime 与 stat 一致 → 文件未变，可安全复用 hash/content 免重读。
 * 仅对文本哈希生效（binary 哈希为 bin: 前缀近似值，不参与复用）。
 */
export function isEntryUnchanged(e: BaselineEntry, size: number, mtime: number): boolean {
  return e.size === size && e.mtime === mtime && !e.hash.startsWith('bin:');
}

export function makeBinaryEntry(size: number, mtime: number): BaselineEntry {
  return { hash: binaryHash(size, mtime), content: null };
}

export function serializeBaseline(baseline: Baseline): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(Object.fromEntries(baseline))));
}

/** 损坏数据抛异常，由调用方走 resync 流程 */
export function parseBaseline(data: Uint8Array): Baseline {
  const json = strFromU8(gunzipSync(data));
  const obj = JSON.parse(json) as Record<string, BaselineEntry>;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('baseline: not an entry map');
  }
  for (const e of Object.values(obj)) {
    if (
      typeof e !== 'object' ||
      e === null ||
      typeof e.hash !== 'string' ||
      !(typeof e.content === 'string' || e.content === null) ||
      (e.size !== undefined && (typeof e.size !== 'number' || !Number.isFinite(e.size) || e.size < 0)) ||
      (e.mtime !== undefined && (typeof e.mtime !== 'number' || !Number.isFinite(e.mtime) || e.mtime < 0))
    ) {
      throw new Error('baseline: invalid entry');
    }
  }
  return new Map(Object.entries(obj));
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') n++;
  return n;
}
