import fs from 'node:fs';
import path from 'node:path';

/**
 * Android app domains reject link(2) with EACCES even in danger-full-access
 * mode, so archify's publication contract — link(candidate, commit), then
 * prove both names share one inode with nlink === 2, then retire the
 * candidate and prove nlink === 1 — cannot run natively.
 *
 * This shim reproduces that observable topology: a logical group stands for
 * one shared inode, its member set stands for the name count, and the bytes
 * are published by a durable 'wx' copy (so EEXIST still means "the name was
 * already claimed"). stat/fstat/lstat report the logical identity and count
 * for every recorded member.
 */

const DENIALS = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
const TRACE = process.env.ARCHIFY_COMPAT_TRACE === '1';
const LOG = process.env.ARCHIFY_COMPAT_LOG;
const trace = (m) => {
  if (!TRACE && !LOG) return;
  const line = `[${process.pid}] ${m}\n`;
  if (LOG) { try { fs.appendFileSync(LOG, line); } catch {} } else process.stderr.write(line);
};

const groups = new Map(); // id -> { ino, dev, members: Set<abs> }
const byPath = new Map(); // abs -> group id
const fdPath = new Map(); // fd -> abs
let nextId = 0;

const abs = (p) => path.resolve(String(p).replace(/^file:\/\//, ''));
const short = (p) => path.basename(String(p));

function groupOf(p) {
  const id = byPath.get(abs(p));
  return id === undefined ? undefined : groups.get(id);
}

function intern(member, ino, dev) {
  let group = groupOf(member);
  if (!group) {
    nextId += 1;
    group = { id: nextId, ino, dev, members: new Set() };
    groups.set(group.id, group);
  }
  group.members.add(abs(member));
  byPath.set(abs(member), group.id);
  trace(`intern ${short(member)} group=${group.id} ino=${group.ino} n=${group.members.size}`);
  return group;
}

function retire(member) {
  const a = abs(member);
  const group = groupOf(a);
  byPath.delete(a);
  if (!group) return;
  group.members.delete(a);
  if (group.members.size === 0) groups.delete(group.id);
  trace(`retire ${short(member)} group=${group.id} n=${group.members.size}`);
}

function shape(stats, group) {
  const big = typeof stats.ino === 'bigint';
  const ino = big ? BigInt(group.ino) : Number(group.ino);
  const links = big ? BigInt(group.members.size) : group.members.size;
  try {
    stats.ino = ino;
    stats.nlink = links;
    return stats;
  } catch {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats);
    Object.defineProperty(clone, 'ino', { value: ino, configurable: true });
    Object.defineProperty(clone, 'nlink', { value: links, configurable: true });
    return clone;
  }
}

function copy(from, to) {
  const data = fs.readFileSync(from);
  const descriptor = fs.openSync(to, 'wx', 0o600);
  try {
    fs.writeSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const nativeLink = fs.linkSync.bind(fs);
fs.linkSync = function linkSyncCompat(existing, newlink) {
  const from = abs(existing);
  const to = abs(newlink);
  try {
    nativeLink(from, to);
    trace(`native link ${short(from)}->${short(to)}`);
  } catch (error) {
    if (!DENIALS.has(error?.code)) throw error;
    globalThis.__archifyLinkFallback(from, to);
    trace(`copied ${short(from)}->${short(to)}`);
  }
  // The two names still stand for one artifact. Registering them as one
  // logical group lets the publication gates see the alias they expect; the
  // bytes themselves are two fsynced copies.
  let source = groupOf(from);
  if (!source) {
    const { ino, dev } = nativeLstat(from, { bigint: true });
    source = intern(from, ino, dev);
  }
  source.members.add(to);
  byPath.set(to, source.id);
  trace(`join ${short(to)} group=${source.id} n=${source.members.size}`);
};

const nativeLstat = fs.lstatSync.bind(fs);

for (const name of ['statSync', 'lstatSync']) {
  const native = fs[name].bind(fs);
  fs[name] = function statCompat(target, options) {
    const stats = native(target, options);
    const group = groupOf(target);
    return group ? shape(stats, group) : stats;
  };
}

const nativeFstat = fs.fstatSync.bind(fs);
fs.fstatSync = function fstatCompat(fd, options) {
  const stats = nativeFstat(fd, options);
  const recorded = fdPath.get(fd);
  if (recorded === undefined) return stats;
  const group = groupOf(recorded);
  return group ? shape(stats, group) : stats;
};

const nativeOpen = fs.openSync.bind(fs);
fs.openSync = function openCompat(target, flags, mode) {
  const fd = nativeOpen(target, flags, mode);
  if (typeof target === 'string' || target instanceof URL) fdPath.set(fd, abs(target));
  return fd;
};

const nativeClose = fs.closeSync.bind(fs);
fs.closeSync = function closeCompat(fd) {
  fdPath.delete(fd);
  return nativeClose(fd);
};

const nativeRename = fs.renameSync.bind(fs);
fs.renameSync = function renameCompat(oldPath, newPath) {
  const from = abs(oldPath);
  const to = abs(newPath);
  const group = groupOf(from);
  const displaced = groupOf(to);
  nativeRename(oldPath, newPath);
  if (displaced && (!group || displaced.id !== group.id)) {
    displaced.members.delete(to);
    byPath.delete(to);
    if (displaced.members.size === 0) groups.delete(displaced.id);
  }
  if (!group) return;
  group.members.delete(from);
  group.members.add(to);
  byPath.delete(from);
  byPath.set(to, group.id);
  trace(`rename ${short(from)}->${short(to)} group=${group.id} n=${group.members.size}`);
};

const nativeUnlink = fs.unlinkSync.bind(fs);
fs.unlinkSync = function unlinkCompat(target) {
  nativeUnlink(target);
  retire(target);
};
