export const BLOCK_START = '<!-- vault-change-feed:start -->';
export const BLOCK_END = '<!-- vault-change-feed:end -->';

/** 两个标记都存在且 start 在 end 之前 */
export function hasBlock(content: string): boolean {
  const start = content.indexOf(BLOCK_START);
  if (start === -1) return false;
  return content.indexOf(BLOCK_END, start + BLOCK_START.length) !== -1;
}

/**
 * 把标记块写入内容：null（文件不存在）→ 块 + 换行；已有标记 → 新块替换两标记之间
 * （含标记行）的内容，标记外逐字保留；无标记 → 追加到文末，与前文空一行（前文非空时）。
 */
export function upsertBlock(content: string | null, block: string): string {
  if (content === null) return block + '\n';
  if (hasBlock(content)) {
    const start = content.indexOf(BLOCK_START);
    const end = content.indexOf(BLOCK_END, start + BLOCK_START.length) + BLOCK_END.length;
    return content.slice(0, start) + block + content.slice(end);
  }
  const kept = content.replace(/\s+$/, '');
  if (kept === '') return block + '\n';
  return kept + '\n\n' + block + '\n';
}

/** 删除标记块；块前紧邻的一个空行一并去掉；无标记 → 原样返回 */
export function removeBlock(content: string): string {
  if (!hasBlock(content)) return content;
  let start = content.indexOf(BLOCK_START);
  let end = content.indexOf(BLOCK_END, start + BLOCK_START.length) + BLOCK_END.length;
  // 块尾标记行的换行一并删除
  if (content[end] === '\n') end++;
  // 块前紧邻一个空行（上一行的换行 + 空行自身的换行）则去掉空行那一个
  if (start > 0 && content[start - 1] === '\n' && (start === 1 || content[start - 2] === '\n')) {
    start--;
  }
  return content.slice(0, start) + content.slice(end);
}
