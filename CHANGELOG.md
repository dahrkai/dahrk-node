# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Client distribution: `dahrk-node` is now a publishable npm package installable three ways
  (`npm install -g dahrk-node`, `brew install dahrkai/tap/dahrk`, `curl -fsSL https://dahrk.ai/install.sh | sh`).
  All three provide the `dahrk` command.
- `dahrk --version` and `dahrk --help`.
- Tag-driven release CI: a `vX.Y.Z` tag publishes to npm, bumps the Homebrew tap formula, and cuts a
  GitHub release.

### Changed

- The `apps/edge-node` package is built with `tsup` into a single bundled `dist/main.js` (the two
  private workspace packages are inlined; published deps stay external) and published as `dahrk-node`.
  The command it installs is `dahrk`.

### Fixed

- The installed binary now runs when invoked through a symlink (as npm/Homebrew global installs do):
  the entrypoint guard resolves `argv[1]` through symlinks, so `dahrk --version` no longer exits
  silently.

## [0.1.0]

Initial public release of the Dahrk edge client (from-source / pm2).

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dahrkai/dahrk-node/releases/tag/v0.1.0
