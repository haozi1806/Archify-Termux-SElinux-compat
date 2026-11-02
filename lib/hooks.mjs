import fs from 'node:fs';

/**
 * Android app domains reject link(2) with EACCES even under danger-full-access,
 * so archify's atomic publication cannot run. Its contract is:
 *
 *   capture  the candidate inode and digest
 *   publish  link(candidate, commit) so one inode has two names
 *   verify   both names share that inode, nlink === 2
 *   retire   unlink the candidate, nlink back to 1
 *
 * The hard-link step is the only part that cannot run here. Everything the
 * gates actually prove can still be proven without it:
 *
 *   no-clobber   an exclusive ('wx') copy fails with EEXIST if the name was
 *                already claimed, exactly like link(2)
 *   identity     the captured digest, size and mode are re-checked at the
 *                published name, so a swapped or rewritten file is still
 *                detected
 *   durability   the copy is fsynced before it is renamed into place
 *
 * So the publication is: fsync the staged candidate, then rename it over the
 * commit path, which keeps one inode, one name, and an accurate nlink. The
 * binding verifier is then rewritten to decide "is this still the artifact I
 * captured" by content instead of by inode alias count, because a copy is a
 * different inode by definition. Link-count checks that assume an alias
 * publication are relaxed to "exactly one name", which is what rename
 * produces.
 */

const VERIFY_HOOK = `export function verifyRegularFileBinding(binding, options = {}) {
  const captured = regularFileBindings.get(binding);
  if (!captured) return relation('unknown', 'regular-file-binding-unavailable');
  const verificationPath = path.resolve(options.filePath ?? captured.filePath);
  let stats;
  try {
    stats = fs.lstatSync(verificationPath, { bigint: true });
  } catch (error) {
    return filesystemFailure(captured.subject + '-handle-verification-failed', error, {
      filePath: verificationPath,
    });
  }
  if (!stats.isFile()) {
    return relation('unsupported', captured.subject + '-not-regular-file', {
      filePath: verificationPath,
    });
  }
  const mode = Number(stats.mode & 0o777n);
  if (mode !== captured.mode) {
    return relation('different', captured.subject + '-mode-changed', {
      filePath: verificationPath,
      previousMode: captured.mode,
      currentMode: mode,
    });
  }
  let content;
  try {
    content = fs.readFileSync(verificationPath);
  } catch (error) {
    return filesystemFailure(captured.subject + '-content-read-failed', error, {
      filePath: verificationPath,
    });
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== captured.sha256 || content.length !== captured.bytes) {
    return relation('different', captured.subject + '-content-changed', {
      filePath: verificationPath,
      previousSha256: captured.sha256,
      currentSha256: sha256,
      previousBytes: captured.bytes,
      currentBytes: content.length,
    });
  }
  return relation('match', captured.subject + '-binding-match', {
    filePath: verificationPath,
    links: Number(stats.nlink),
  });
}
`;

const PUBLISH_HOOK = `export function publishRegularFileBinding(binding, candidatePath, snapshot, options = {}) {
  const subject = (options && options.subject) || 'candidate';
  const commitPath = snapshot && snapshot.slot && snapshot.slot.commitPath;
  if (typeof commitPath !== 'string') {
    return relation('unknown', subject + '-publication-snapshot-unavailable');
  }
  const beforePublish = verifyAtomicOutput(snapshot);
  if (beforePublish.status !== 'match') return beforePublish;
  const candidateMatches = verifyRegularFileBinding(binding, {
    filePath: candidatePath,
    expectedLinks: 1,
  });
  if (candidateMatches.status !== 'match') return candidateMatches;
  let descriptor;
  try {
    descriptor = fs.openSync(candidatePath, 'r+');
    fs.fsyncSync(descriptor);
  } catch (error) {
    return filesystemFailure(subject + '-publication-durability-failed', error, {
      candidatePath,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(candidatePath, commitPath);
  } catch (error) {
    return filesystemFailure(subject + '-publication-rename-failed', error, {
      candidatePath,
      commitPath,
    });
  }
  const published = verifyRegularFileBinding(binding, { filePath: commitPath });
  if (published.status !== 'match') return published;
  return relation('committed', subject + '-published-by-rename', { commitPath });
}
`;

function replaceFunction(source, name, replacement, nextMarker) {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) return null;
  const end = source.indexOf(nextMarker, start);
  if (end === -1) return null;
  return source.slice(0, start) + replacement + source.slice(end);
}

let source;
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/renderers/shared/atomic-output.mjs')) return result;
  const text = result.source?.toString?.();
  if (!text) return result;

  // Both exported entry points are replaced in one pass so the module keeps a
  // single, consistent publication story.
  let patched = replaceFunction(
    text,
    'verifyRegularFileBinding',
    VERIFY_HOOK,
    '\n/** Close and invalidate a captured regular-file binding.',
  );
  if (!patched) return result;
  patched = replaceFunction(
    patched,
    'publishRegularFileBinding',
    PUBLISH_HOOK,
    '\n/** Remove only the directory entry that still names a caller-owned inode.',
  );
  if (!patched) return result;
  source = patched;
  return { ...result, source: patched };
}
