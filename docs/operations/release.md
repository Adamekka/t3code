# Nightly macOS releases

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork publishes one unsigned Apple Silicon DMG for installation through a Homebrew Cask. It does
not publish stable releases or other T3 Code products.

## Workflow

The release workflow is `.github/workflows/release.yml`.

It runs in two cases:

- Every three hours. A scheduled run stops when `main` still points at the commit tagged by the most
  recent nightly release.
- Manual `workflow_dispatch`. Manual runs always proceed, which allows a failed release to be retried.

A newer invocation cancels an older in-progress invocation so two nightlies cannot race to publish.

Each release runs these stages in order:

1. Check formatting and linting for the macOS app code.
2. Typecheck and test the desktop app and its workspace dependency set.
3. Run the release smoke test.
4. Build the native resource monitor and an unsigned arm64 DMG on GitHub's `macos-15` runner.
5. Publish the DMG in a GitHub prerelease.

The workflow does not build or publish Intel macOS, Windows, Linux, mobile, npm, AUR, the hosted web
app, T3 Connect relay configuration, or Discord announcements.

## Versioning

Nightly tags use this format:

```text
vX.Y.Z-nightly.YYYYMMDD.<run_number>
```

The nightly base is the next patch after the version in `apps/desktop/package.json`. For example,
`0.0.33` produces `0.0.34-nightly.*`. The release name also includes the source commit's short SHA.
Nightlies are always prereleases and never become the repository's latest stable release.

## DMG behavior

The workflow invokes the desktop packager with `--no-updates`. This explicit mode omits the Electron
update feed and creates only the DMG instead of also creating ZIP, YAML, and blockmap updater assets.
Homebrew is responsible for delivering later versions.

The build is unsigned and not notarized, so users may need to right-click the app and choose **Open**
on first launch. The workflow does not require Apple, Azure, Clerk, Cloudflare, Vercel, npm, or Discord
secrets.

## Manual release

Run the **Nightly** workflow from the GitHub Actions page. A manual invocation publishes a real
nightly prerelease even when the source commit already has another nightly tag.

After the workflow succeeds, use the release's arm64 DMG URL and checksum in the Homebrew Cask. The
Cask should install the app bundle from the mounted image:

```ruby
app "T3 Code (Nightly).app"
```

The packaged product name comes from the nightly version, so verify the bundle name when creating the
first Cask revision.
