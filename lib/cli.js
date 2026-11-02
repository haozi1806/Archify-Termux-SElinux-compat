#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run an Archify CLI command on Android with the compatibility preload.
 *
 * Usage: node lib/cli.js <archify.mjs> [archify args...]
 *
 * Exit status and output are forwarded unchanged so callers can treat this as
 * Archify itself. NODE_OPTIONS is extended rather than replaced, and the
 * preload is applied to the parent and inherited by every child Archify
 * spawns (renderers, finalize stages, browser checks).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.mjs');

const [, , archifyPath, ...args] = process.argv;
if (!archifyPath) {
  console.error('usage: node lib/cli.js <archify.mjs> [archify args...]');
  process.exit(2);
}
if (!fs.existsSync(archifyPath)) {
  console.error(`archify entry not found: ${archifyPath}`);
  process.exit(2);
}

const nodeBinary = resolveNode();
const existing = process.env.NODE_OPTIONS || '';
const nodeOptions = existing.includes(preload)
  ? existing
  : `${existing} --import ${JSON.stringify(preload)}`.trim();

const result = spawnSync(nodeBinary, [archifyPath, ...args], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

if (result.error) {
  console.error(`failed to start archify: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

/** Resolve the real ELF node binary, never the termux-exec linker wrapper. */
function resolveNode() {
  const candidates = [];
  if (process.env.TERMUX_EXEC__PROC_SELF_EXE) candidates.push(process.env.TERMUX_EXEC__PROC_SELF_EXE);
  try {
    const argv = fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
    for (let i = 1; i < Math.min(argv.length, 4); i += 1) candidates.push(argv[i]);
  } catch {}
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'node'));
  }
  return candidates.find(isElf) ?? process.execPath;
}

function isElf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const magic = Buffer.alloc(4);
      fs.readSync(fd, magic, 0, 4, 0);
      return magic.toString('latin1') === '\x7fELF';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
