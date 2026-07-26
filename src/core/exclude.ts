export interface ExcludeOptions {
  /** Obsidian 配置目录，如 '.obsidian'，恒排除（含插件自身输出，防自激） */
  configDir: string;
  /** 小写、不带点的扩展名列表 */
  trackedExtensions: string[];
  extraGlobs: string[];
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function isExcluded(path: string, opts: ExcludeOptions): boolean {
  const cfg = opts.configDir.replace(/\/+$/, '');
  if (path === cfg || path.startsWith(cfg + '/')) return true;
  return opts.extraGlobs.some(g => {
    const t = g.trim();
    return t.length > 0 && globToRegExp(t).test(path);
  });
}

export function isTextFile(path: string, trackedExtensions: string[]): boolean {
  const m = /\.([^./]+)$/.exec(path);
  return m !== null && trackedExtensions.includes(m[1].toLowerCase());
}
