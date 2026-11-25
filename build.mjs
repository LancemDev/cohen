import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

const shared = {
  bundle: true,
  format: 'esm',
  target: ['chrome139'],
  sourcemap: true,
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await mkdir(path.join(outdir, 'icons'), { recursive: true });
  await cp('public', outdir, { recursive: true });

  // esbuild can't emit the manifest; keep it as the source of truth.
  const manifest = await readFile('src/manifest.json', 'utf8');
  await writeFile(path.join(outdir, 'manifest.json'), manifest);
}

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await copyStatic();

  const configs = [
    {
      ...shared,
      entryPoints: ['src/background/service-worker.ts'],
      outfile: path.join(outdir, 'background/service-worker.js'),
    },
    {
      ...shared,
      format: 'iife',
      entryPoints: ['src/content/youtube.ts'],
      outfile: path.join(outdir, 'content/youtube.js'),
    },
    {
      ...shared,
      entryPoints: ['src/offscreen/offscreen.ts'],
      outfile: path.join(outdir, 'offscreen/offscreen.js'),
    },
    {
      ...shared,
      entryPoints: ['src/popup/popup.ts'],
      outfile: path.join(outdir, 'popup/popup.js'),
    },
    {
      ...shared,
      entryPoints: ['src/options/options.ts'],
      outfile: path.join(outdir, 'options/options.js'),
    },
  ];

  if (watch) {
    const contexts = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('Watching for changes...');
    return;
  }

  await Promise.all(configs.map((c) => build(c)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
