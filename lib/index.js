import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Android/Termux compatibility layer for the Archify skill.
 *
 * Archify assumes two Linux behaviors that Android app domains do not provide:
 *
 *   1. process.execPath is the real Node binary. termux-exec rewrites execve
 *      through /system/bin/linker64, so execPath reports the linker and any
 *      spawn of it hands a .mjs file to a dynamic linker ("bad ELF magic").
 *   2. link(2) works. SELinux rejects it with EACCES even under
 *      danger-full-access, which breaks the whole no-clobber publication
 *      contract (link, verify nlink === 2, retire the candidate, nlink === 1).
 *
 * Both are repaired inside the Node process by `preload.mjs`, which is injected
 * with NODE_OPTIONS so every Archify child process inherits it.
 */

export const name = 'archify-selinux-compat';

export const PACKAGE_NAME = 'archify-selinux-compat';

/** Absolute path of the preload module that installs both compatibility fixes. */
export function resolvePreloadUrl(profileBaseUrl) {
  if (!profileBaseUrl) {
    throw new Error('archify-selinux-compat: missing DSH profile baseUrl for package resolution');
  }
  let manifestPath;
  try {
    manifestPath = createRequire(profileBaseUrl).resolve(`${PACKAGE_NAME}/package.json`);
  } catch (error) {
    throw new Error(
      `archify-selinux-compat: cannot resolve ${PACKAGE_NAME}/package.json from the DSH profile`,
      { cause: error },
    );
  }
  return join(dirname(manifestPath), 'lib', 'preload.mjs');
}
