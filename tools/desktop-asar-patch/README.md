# Desktop asar patch tool

English | [中文](README.zh.md)

Injects prebuilt client bundles into an installed DeepSeek Harness desktop app by
rewriting entries inside `resources/app.asar`. It exists because a performance
patch has to reach a machine that only has the release build, not a source
checkout.

The tool patches two client bundles:

| Package | What the patch changes |
|---|---|
| `@deepseek-ai/dsh-client-ui-chat` | `ChatSnapshotBuilder` takes a tail-append fast path for live Steps |
| `@deepseek-ai/dsh-client-ui-conversation` | Turn identity survives advancing Steps; restructured Turns are re-marked dirty |

## Files

| File | Role |
|---|---|
| `patch-asar.cjs` | Installer. Reads `manifest.json`, rewrites the archive, verifies every entry. |
| `build-payload.cjs` | Regenerates `payload/` and `manifest.json` for a new release. |
| `manifest.json` | Target release, archive entries, and the expected baseline and patched sha256 of each bundle. |
| `payload/` | The aligned client bundles that get written into the archive. |
| `apply-patch.cmd` | Windows launcher that runs the installer with the app's own Electron binary. |

## Patching a machine

1. Quit DeepSeek Harness completely, including the tray icon.
2. Run `apply-patch.cmd`, or `apply-patch.cmd "C:\Program Files\DeepSeek Harness"`.

   Without an argument the launcher tries `D:\deepseek-harness`,
   `C:\Program Files\DeepSeek Harness`, then
   `%LOCALAPPDATA%\Programs\DeepSeek Harness`.
3. Expect `verify     : entries ..., integrity failures 0, aligned true`.
4. Start DeepSeek Harness.

The installer copies the original archive to `app.asar.pre-patch` before writing
and refuses to touch an archive whose bundles do not match the recorded baseline,
so a wrong release or a foreign patch fails loudly instead of corrupting the app.
Re-running is safe: already-patched bundles are reported and skipped.

Options: `--app <dir>`, `--dry-run`, `--restore`, `--force`.

## Rebuilding for a new release

The bundles must be built from the release's own sources. A build from a newer
`master` links against APIs the release does not ship, so its bundle registers
correctly but fails at runtime.

```sh
git worktree add ../dsh-release <release-tag> -b perf/<release>-patched-host
cd ../dsh-release
git cherry-pick <patch commits>
pnpm install --frozen-lockfile
pnpm run build:artifacts
```

Then build the unpatched baseline in the same worktree, because the CSS module
prefix is a content hash that changes between builds:

```sh
git checkout <release-tag> -- <the patched source files>
pnpm run build:lib:client
cp packages/client/ui-chat/lib/client.js            ../baseline/ui-chat.client.js
cp packages/client/ui-conversation/lib/client.js    ../baseline/ui-conversation.client.js
git checkout HEAD -- <the patched source files>
pnpm run build:lib:client
cp packages/client/ui-chat/lib/client.js            ../patched/ui-chat.client.js
cp packages/client/ui-conversation/lib/client.js    ../patched/ui-conversation.client.js
```

Finally regenerate the payload against the archive actually being patched:

```sh
node tools/desktop-asar-patch/build-payload.cjs \
  --stock "<install dir>/resources/app.asar" \
  --baseline ../baseline --patched ../patched
```

`build-payload.cjs` refuses to run when the baseline build differs from the
shipped bundle by anything other than CSS class hashes, so a build from the wrong
sources is caught before it becomes a payload.

## Why the CSS hash remap exists

`packages/client/tsdown.client.ts` configures `cssModules: { pattern: '[hash]_[local]' }`.
The hash covers the build environment, so the same sources produce different
prefixes on different machines. The generator pairs the local and shipped token
lists in first-appearance order and rewrites the patched bundle's prefixes to the
shipped ones. The result differs from the official bundle only where the patch
differs, which is what makes the patched archive reproducible: the same release
plus the same patch commits yields the same `app.asar` sha256 anywhere.
