# Homebrew distribution

**Confidentiality:** Internal
**Status:** DRAFT - UNREVIEWED

`dahrk.rb` here is the canonical source of the Homebrew formula for the Dahrk edge client. Users
install it with:

```sh
brew install dahrkai/tap/dahrk
```

The npm package is `dahrk-node`; the binary/command it exposes is `dahrk`.

## How it stays current

On every tagged release, `.github/workflows/release.yml` publishes `dahrk` to npm, then rewrites the
`url` and `sha256` in the tap repo's `Formula/dahrk.rb` to point at the just-published tarball and
pushes the change. So after the one-time bootstrap below, the tap updates itself.

## Bootstrap status

The tap repo `github.com/dahrkai/homebrew-tap` exists and is public. The release workflow keeps
`Formula/dahrk.rb` up to date automatically (requires the `TAP_PUSH_TOKEN` secret, a PAT with
`repo` scope on `dahrkai/homebrew-tap`).

The formula ships with a placeholder `sha256` until `dahrk-node` has its first npm release. After
the first publish, set the real values:

```sh
curl -fsSL https://registry.npmjs.org/dahrk-node/-/dahrk-node-<version>.tgz | shasum -a 256
```

Then update `url`/`sha256` in `Formula/dahrk.rb` in the tap repo and commit. Verify with:

```sh
brew install --build-from-source ./Formula/dahrk.rb && brew test dahrk
```
