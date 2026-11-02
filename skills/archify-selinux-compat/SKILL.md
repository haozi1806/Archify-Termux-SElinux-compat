---
name: archify-selinux-compat
description: Run Archify diagram generation on Android/Termux through the compatibility preload that fixes the SELinux link(2) rejection and the termux-exec process.execPath misreport. Use when Archify fails with "bad ELF magic", "target-indeterminate", "target-hardlinked", or an EACCES link error.
---

# Archify on Android

Load the `archify` skill for diagram authoring. This skill only changes *how*
Archify is executed so its own checks pass on Android.

## The two platform failures

Archify assumes Linux behavior that Android app domains do not provide:

| Assumption | What Android does | Symptom |
|---|---|---|
| `process.execPath` is the Node binary | termux-exec rewrites `execve` through `/system/bin/linker64`, so `execPath` is the linker | `has bad ELF magic: 696d706f` when Archify re-runs itself |
| `link(2)` works | SELinux rejects it with `EACCES`, even in danger-full-access | `output/target-indeterminate`, `output/target-hardlinked`, `*-publication-link-failed` |

`link(2)` is the load-bearing one. Archify publishes an artifact by
`link(candidate, commit)`, proves both names share one inode with `nlink === 2`,
retires the candidate, then proves `nlink === 1`. Without hard links the whole
no-clobber contract collapses, which is why a plain copy retry does not help.

## Run Archify through the wrapper

```
node <plugin>/lib/cli.js <archify.mjs> <command> [args...]
```

- `<plugin>`: the `archify-selinux-compat` package directory
- `<archify.mjs>`: `<archify-skill>/bin/archify.mjs`
- remaining arguments: forwarded unchanged to Archify

The wrapper resolves the real ELF Node binary, then runs Archify with
`NODE_OPTIONS=--import <plugin>/lib/preload.mjs`. That preload is inherited by
every child Archify spawns, so renderers, `finalize` stages, and the browser
gate all run patched. Exit status and output are Archify's own.

Do not edit files inside the installed Archify package; the preload is injected
at run time and survives a package update.

## What the preload changes

- `process.execPath` — repointed at the real ELF Node binary, so child spawns
  stop handing `.mjs` files to the linker.
- `fs.linkSync` — falls back to an exclusive (`wx`) `fsync`ed byte copy. `EEXIST`
  still propagates, so "this name was already claimed" stays the same signal.
- `publishRegularFileBinding` — replaced by `fsync` + `rename`, keeping one
  inode and an accurate `nlink`.
- `verifyRegularFileBinding` — decides by mode, size, and SHA-256 instead of
  inode alias count, because a copy is a different inode by definition.

Trade-off: cross-process alias detection via `nlink` is unavailable on Android.
Content identity is still enforced, so a swapped or rewritten artifact is
still rejected.

## Expected results

```
archify finalize architecture cand.json out.html --quality showcase --json
  validate      pass
  deliver       pass
  check         pass
  browser-check pass   (needs Chrome; skipped without it)
```

`browser-check` needs a real Chrome/Chromium and is unrelated to SELinux. When
it reports `viewer/chrome-unavailable`, report that as an environment limit
instead of a compatibility failure.

## Triage

- `bad ELF magic` — the preload did not reach the child. Confirm
  `NODE_OPTIONS` contains `--import` and the absolute preload path, and that
  Archify was started through `lib/cli.js`.
- `target-indeterminate` / `target-hardlinked` — the `fs.linkSync` shim did not
  load, or Archify was launched without the preload.
- `*-publication-link-failed` with `EACCES` — same cause: raw `link(2)` still
  reached SELinux.
- `link-count-changed` on a verification — the shim's logical group and the
  rename step disagree; rerun the command from a clean output directory before
  assuming a regression.
