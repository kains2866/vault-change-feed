import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtinModules],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

// merge 单源运行时产物（供 extras/vault-feed-hook.mjs 引用，随构建同步）
const mergeContext = await esbuild.context({
  entryPoints: ['src/core/merge.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  logLevel: 'info',
  outfile: 'extras/merge-runtime.mjs',
});

if (prod) {
  await context.rebuild();
  await mergeContext.rebuild();
  process.exit(0);
} else {
  await context.watch();
  await mergeContext.watch();
}
