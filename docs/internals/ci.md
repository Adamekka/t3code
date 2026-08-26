# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork runs quality checks as part of
[the nightly release workflow](../../.github/workflows/release.yml). It does not run GitHub Actions
for pull requests or pushes to `main`.

[The upstream rebase workflow](../../.github/workflows/rebase-upstream.yml) runs every three hours,
offset 30 minutes from Nightly, and supports manual runs. It rebases the fork's `main` branch onto
`pingdotgg/t3code`'s `main` branch so the fork-only commits remain at the top of the history. A
conflict fails the workflow without changing the fork. Successful runs use a fixed force-with-lease,
so a concurrent update to the fork's `main` branch also fails instead of being overwritten.

Scheduled and manual nightlies run these checks before packaging:

- Formatting and linting for the desktop app, embedded server and web client, shared packages,
  repository scripts, and the native resource monitor.
- TypeScript typechecks and tests for the desktop app and its transitive workspace dependencies.
- `vp run release:smoke`, which exercises nightly version resolution, package version alignment,
  lockfile regeneration, and release metadata handling.

The release job runs on GitHub's `macos-15` arm64 runner. It builds the native resource monitor and
packages one unsigned Apple Silicon DMG. The DMG has no Electron update feed because Homebrew owns
updates for this distribution. After publishing the GitHub prerelease, the job updates the version
and checksum in `Adamekka/homebrew-tap` and pushes the Cask change to its `main` branch.

After the release job succeeds, a dependent `ubuntu-24.04` job updates the x86_64 Linux package in
`Adamekka/nur-packages` to the resolved nightly version. It recalculates the source, pnpm, and Cargo
hashes, builds the package, and pushes the change only after the build succeeds.

See [Nightly releases](../operations/release.md) for triggers and release behavior.
