import { LineStat } from './types';

/** diff 中间段单侧行数上限，超过返回 null（避免 Myers 最坏情况卡顿） */
export const MAX_DIFF_LINES = 5000;

/**
 * 行级 diff 统计：返回 {added, removed}。
 * 基于公共前后缀裁剪 + Myers O(ND) 求 LCS 长度：added = m - lcs，removed = n - lcs。
 */
export function lineStat(oldContent: string, newContent: string): LineStat | null {
  if (oldContent === newContent) return { added: 0, removed: 0 };
  const a = oldContent.split('\n');
  const b = newContent.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midALen = endA - start;
  const midBLen = endB - start;
  if (midALen === 0) return { added: midBLen, removed: 0 };
  if (midBLen === 0) return { added: 0, removed: midALen };
  if (midALen > MAX_DIFF_LINES || midBLen > MAX_DIFF_LINES) return null;

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const lcs = lcsLength(midA, midB);
  return { added: midBLen - lcs, removed: midALen - lcs };
}

/** Myers O(ND) 最短编辑距离推 LCS 长度：lcs = (n + m - d) / 2 */
function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return (n + m - d) / 2;
    }
  }
  return 0; // 不可达
}
