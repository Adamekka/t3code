# Nightly releases

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork publishes one unsigned Apple Silicon DMG through a Homebrew Cask and one x86_64 Linux Nix
package through `Adamekka/nur-packages`. It does not publish stable releases or other T3 Code
products.

## Workflow

The release workflow is `.github/workflows/release.yml`.

It runs in two cases:

- Every three hours. A scheduled run stops when `main` still points at the commit tagged by the most
  recent nightly release.
- Manual `workflow_dispatch`. Manual runs always proceed, which allows a failed release to be retried.

A newer invocation cancels an older in-progress invocation so two nightlies cannot race to publish.

Each release runs these stages in order:

1. Build the native resource monitor and an unsigned arm64 DMG on GitHub's `macos-15` runner.
2. Publish the DMG in a GitHub prerelease.
3. Update and publish the Homebrew Cask.
4. Update and build the NUR package on an `ubuntu-24.04` runner, then push it to the NUR repository.

The workflow does not build or publish Intel macOS, Windows, mobile, npm, AUR, the hosted web app, T3
Connect relay configuration, or Discord announcements.

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
on first launch. The workflow requires two fine-grained GitHub tokens with Contents write access:
`HOMEBREW_TAP_TOKEN` for `Adamekka/homebrew-tap` and `NUR_PACKAGES_TOKEN` for
`Adamekka/nur-packages`. It does not require Apple, Azure, Clerk, Cloudflare, Vercel, npm, or Discord
secrets.

After the DMG is published, the workflow checks out the tap, updates the Cask's version and SHA-256,
and pushes the change to `main`. A tap checkout or push failure fails the release job so a stale Cask
is visible. Users receive the new Cask through `brew update` and `brew upgrade --cask
adamekka-t3-code`; Homebrew does not upgrade installed applications in the background by default.

After the release job succeeds, a dependent Linux job checks out `Adamekka/nur-packages`, updates the
Nix source and dependency hashes to the exact nightly version, and builds `.#t3code`. It pushes the
package change to `main` only after that build succeeds.

## Manual release

Run the **Nightly** workflow from the GitHub Actions page. A manual invocation publishes a real
nightly prerelease even when the source commit already has another nightly tag. The same run updates
the Homebrew Cask and NUR package after publishing the release asset; no manual hash edit is required.
