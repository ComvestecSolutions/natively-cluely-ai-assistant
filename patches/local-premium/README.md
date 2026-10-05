# Manual premium editor persistence patch

`ModesSettings.persistence.patch.txt` is a unified diff containing only the
`handleDuplicate` and `handleSavePrompt` changes made on 2026-10-05 in the existing
local `premium/src/ModesSettings.tsx` scaffold. Failed prompt saves retain their
error without refreshing; failed prompt copies report partial creation without
selecting the incomplete copy. It contains no unrelated scaffold implementation.

## Provenance

The baseline is the local editor at the start of the implementation task, NOT
the private submodule's pinned source. Original callback text was restored in
memory; the reconstructed full-file bytes exactly matched the SHA256 captured
before editing. Full original source was not saved as a separate file.

- Original local editor SHA256: `80ae8be851179fd28211adef172a80ee0fb2535f8650091c1d18e71473944193`
- Edited local editor SHA256: `059045827248a552bad89bc58d4238cea0343651cfe7326f43419cb6e3b94374`
- Parent HEAD/index premium gitlink: `9f83a1902364ab1401d6bb1f9070b967b7648024`

The premium checkout is uninitialized: `premium/.git`, `.git/modules/premium`,
and the pinned commit object are unavailable. No match to that private baseline
is asserted. Parent Git diffs cannot represent the local editor changes.

## Delivery and tests

Review and merge these two callbacks after restoring the private submodule;
do not replace its editor wholesale or assume the patch applies unchanged.
The verified original and edited local files use CRLF, as does this local patch
artifact. Preserve the restored checkout's line endings when merging. It uses
zero-context hunks; any manual `git apply` check requires `--unidiff-zero`.
Verify the baseline hash first and review the result rather than applying it
blindly to a different private checkout.

The `.patch.txt` suffix is intentional: installed `patch-package` recursively
finds files ending in `.patch`, including nested directories. This manual patch
must not enter the native-package postinstall pipeline.

Tests execute actual current source, never this artifact or a fixture fallback.
Optional preservation checks read patch/metadata bytes only to ensure tests do
not modify them. Without the local editor, premium callback tests explicitly
skip; the artifact does not supply a replacement implementation.

The previous full-scaffold snapshot was removed after baseline/hash and focused
patch validation. No project/submodule patch application, initialization,
staging, commit, push, or gitlink change was performed for this delivery.
