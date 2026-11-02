import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

globalThis.__archifyCompatFs = fs;

/**
 * Exclusive byte copy standing in for link(2), which Android app domains
 * reject with EACCES. 'wx' keeps the no-clobber guarantee: a second claimant
 * still fails with EEXIST instead of overwriting the published name.
 */
globalThis.__archifyLinkFallback = (existing, newlink) => {
  const descriptor = fs.openSync(newlink, 'wx', 0o600);
  try {
    fs.writeSync(descriptor, fs.readFileSync(existing));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

function elfMagic(file) {
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

/**
 * termux-exec intercepts execve and re-runs ELF binaries through
 * /system/bin/linker64, so process.execPath reports the linker instead of
 * node. Any spawn of process.execPath would then hand a .mjs file to the
 * linker and fail with "bad ELF magic". Resolve the real ELF node binary once
 * and publish it as execPath for this process and every child that inherits
 * the environment.
 */
function resolveNodeBinary() {
  const candidates = [];
  if (process.env.TERMUX_EXEC__PROC_SELF_EXE) candidates.push(process.env.TERMUX_EXEC__PROC_SELF_EXE);
  try {
    const argv = fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
    for (let i = 1; i < Math.min(argv.length, 4); i += 1) candidates.push(argv[i]);
  } catch {}
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'node'));
  }
  return candidates.find(elfMagic) ?? null;
}

const realNode = resolveNodeBinary();
if (realNode) process.execPath = realNode;

register(new URL('./hooks.mjs', import.meta.url));
await import('./hardlink-shim.mjs');
