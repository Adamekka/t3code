# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork runs CI as part of [the nightly release workflow](../../.github/workflows/release.yml).
It does not run GitHub Actions for pull requests or pushes to `main`.

Scheduled and manual nightlies run these checks before packaging:

- Formatting and linting for the desktop app, embedded server and web client, shared packages,
  repository scripts, and the native resource monitor.
- TypeScript typechecks and tests for the desktop app and its transitive workspace dependencies.
- `vp run release:smoke`, which exercises nightly version resolution, package version alignment,
  lockfile regeneration, and release metadata handling.

The release job runs on GitHub's `macos-15` arm64 runner. It builds the native resource monitor and
packages one unsigned Apple Silicon DMG. The DMG has no Electron update feed because Homebrew owns
updates for this distribution.

See [Nightly macOS releases](../operations/release.md) for triggers and release behavior.
