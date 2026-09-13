# Adaptation notes

Deep-dive on what was wrong, exactly what changed, and how to re-apply it after an upstream
release. Written while adapting `computer-user@0.3.6` for **DSH 0.1.5-rc.1** on Windows.

---

## 1. The silent load failure

### Symptom

Nothing. No tool, no settings card, no `/computer` command, **no error in the DSH boot log**. The
plugin looks installed — it is listed in `dsh --dump-config` — and does absolutely nothing.

### Cause

```js
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
```

The installed `dsh-settings` (0.1.5-rc.2) exports exactly:

```
SettingsConflictError, SettingsProvider, default, redactSecrets
```

A **missing named export fails the entire ES module at link time**. The module never evaluates, so
`apply()` never runs, so `ctx.tools.register` is never called.

Reproduce it outside DSH, which is how this was pinned down:

```bash
node --input-type=module -e "import('file:///<profile>/node_modules/computer-user/src/index.js').then(m=>console.log('OK',Object.keys(m))).catch(e=>console.log('FAILED:',e.message))"
# FAILED: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
```

The upstream peers are `^0.1.0-rc.6 || ^0.1.1-rc.2`. Under semver a prerelease range only matches
the **same** `major.minor.patch`, so `^0.1.1-rc.2` can never match `0.1.5-rc.2`. pnpm's
"issues with peer dependencies" warning was pointing at this the whole time.

### Fix

Import the module namespace and feature-detect — the same bridge `dsh-imagegen` uses:

```js
import * as settingsModule from '@deepseek-ai/dsh-settings';

function settingsNamespaceCompat(value) {
  return settingsModule.settingsNamespace?.(value) ?? value;
}
```

The namespace is now just the plain string `'computer-user'` handed to `provider.register()`. If a
future DSH restores the module-level helper, the shim picks it up and nothing else changes.

### Sibling fix: the write path

`SettingsScope.set(key, value)` was replaced by `update(patch)`. Kept as a runtime fallback so the
plugin works on both generations:

```js
sourceSetter = (key, value) => (
  typeof scope.update === 'function'
    ? scope.update({ [key]: value })
    : scope.set(key, value)
);
```

---

## 2. Vision-facing screenshots

### The contract

A DSH tool returns content blocks. To hand the model a picture it must emit an image block beside
its text, with the attachment reference coming from the host service:

```js
const ref = await attachments.saveImage({ data, mediaType, name });
return [
  { type: 'text',  text: envelope },
  { type: 'image', attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType,
                                 bytes: ref.bytes, width: ref.width, height: ref.height } },
];
```

### The routing gate

Mirror the host `read_image` gate exactly — request-header config first, then the agent's options —
and treat an unresolvable route as text-only:

```js
const info = await llm.resolveModelInfo(provider, model, exec.signal);
const imageCapable = info?.inputModalities?.includes('image') === true;
```

### The coordinate mapping

`resolveModelInfo` does **not** expose the route's image pixel budget, so the plugin uses DeepSeek's
documented normal-vision projection (640 000 px) as `vision_max_pixels`, re-capturing smaller when
the first shot exceeds it. That keeps preview dimensions equal to file dimensions and the factor
exact; if the attachment service still normalizes on save, the ratio is folded in:

```
kx = (capture.width / stored.width) / capture.scale
ky = (capture.height / stored.height) / capture.scale
screen = virtual_offset + image_px * [kx, ky]
```

The executor reports `screen_per_image` (exact screen pixels per image pixel, computed after any
region crop and rounded resize) and `virtual_offset` is already the crop origin, so the same formula
holds for region captures.

> Superseded detail: this factor used to be derived from the *requested* `capture.scale`, which is
> only approximately right once the bitmap size is rounded. `screen_per_image` is exact.

### Fallbacks

Four independent conditions drop back to the original path contract, and a failed `saveImage` never
loses the screenshot:

1. `vision_feedback === false`
2. the route does not declare image input
3. no `attachments` service is mounted
4. `saveImage` throws (oversized, unsupported, disk)

---

## 3. Persistence layers

| Layer | What it buys |
|---|---|
| `pnpm patch` + `patchedDependencies` | survives ordinary reinstalls |
| **exact version pin** (`"computer-user": "0.3.6"`, no caret) | a patch key is version-exact, so a range bump silently drops the patch — pinning removes that failure mode |
| `settingsNamespaceCompat` feature detection | the code survives DSH moving between API generations |
| `postinstall` → doctor | self-checks and repairs API drift after any `dsh plugin add/update` |

### A real hazard found while building this

pnpm **hard-links** `node_modules` files to its content-addressed store. Verified on this machine:
an untouched package's file reports two links (store + `node_modules`), while a `pnpm patch`ed
package reports one — patched content is copied, not linked.

So a naive in-place `writeFile` from a repair tool can follow the link and **corrupt the shared
store**, poisoning every other project on the machine. The doctor therefore writes a sibling temp
file and renames it, which swaps in a fresh inode:

```js
async function replaceFileSafely(path, contents) {
  const tmp = `${path}.doctor-tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);   // new inode; the store entry is untouched
}
```

This only matters in exactly the case the doctor exists for: the patch was dropped, the package is
pristine again, and therefore hard-linked.

### `pnpm store status` reports mutations — mostly not yours

`pnpm store status` flags ~80 packages here including many never touched by this work, strongly
correlated with DSH's own `.dsh-module-fallback` copies (47 of 49 fallback packages flagged). Treat
it as a pre-existing property of this environment, not evidence of this fork's writes.

---

## 4. Re-applying after an upstream release

1. Re-apply the changes in the root README's table to the new source.
2. If you maintain a pnpm patch: `pnpm patch computer-user@<new-version> -d <dir>`, copy the changes
   in, then `pnpm patch-commit <dir>` (needs `git` on `PATH`).
3. Update the version pin and the `patchedDependencies` key together — they must match exactly.
4. Re-run the whole `verify/` suite.

### A patch-portability trap worth knowing

Upstream ships **CRLF** line endings — `npm pack computer-user@0.3.6` yields a `src/index.js` with
199 CR and 199 LF bytes. A `pnpm patch` generated on Windows therefore carries CRLF context, and as
soon as any modified file is rewritten with LF the patch becomes internally mixed. Measured result:

| tool | outcome |
|---|---|
| `pnpm install` | applies fine — pnpm's patcher is tolerant |
| `git apply --check` on the raw CRLF tarball | **fails** |
| `git apply --check` on an LF-normalized copy | **fails** |

So the generated patch is a pnpm-only artifact. It is deliberately **not** shipped in this
repository: an artifact that looks portable but is not would be worse than none. Install the fork
and merge upstream changes deliberately instead.

---

## 5. Reporting upstream

Every DSH ≥ 0.1.2 user gets a completely inert plugin with no diagnostic at all. That is worth an
upstream issue: <https://github.com/jing-hy/computer-user/issues>.
