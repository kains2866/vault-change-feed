import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { hashContent, binaryHash } from './hash';

export interface BaselineEntry {
  hash: string;
  /** 文本文件为全文；二进制/大文件为 null */
  content: string | null;
}

export type Baseline = Map<string, BaselineEntry>;

export function makeTextEntry(content: string): BaselineEntry {
  return { hash: hashContent(content), content };
}

/**
 * 预算内存全文：超预算只存哈希（变更检测仍精确，diff 退化为 stat null）。返回新 entry。
 * usedBytes 为当前基线已占用的内容字节数（见 entryContentBytes）。
 */
export function makeTextEntryBudgeted(
  content: string,
  usedBytes: number,
  budgetBytes: number,
): BaselineEntry {
  if (usedBytes + content.length * 2 > budgetBytes) {
    return { hash: hashContent(content), content: null };
  }
  return makeTextEntry(content);
}

/** entry 全文占用的估算字节数（UTF-16 码元 × 2）；无全文为 0 */
export function entryContentBytes(e: BaselineEntry): number {
  return e.content === null ? 0 : e.content.length * 2;
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
      !(typeof e.content === 'string' || e.content === null)
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
