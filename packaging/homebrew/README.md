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

## One-time bootstrap (first release only)

The tap is a separate public repo, `github.com/dahrkai/homebrew-tap` (a Homebrew tap repo must be
named `homebrew-<tap>`). It does not exist yet. To create it:

1. Create the repo `dahrkai/homebrew-tap` (public).
2. Copy this `dahrk.rb` to `Formula/dahrk.rb` in that repo.
3. After the first `dahrk-node` version is on npm, set the real `sha256`:
   ```sh
   curl -fsSL https://registry.npmjs.org/dahrk-node/-/dahrk-node-<version>.tgz | shasum -a 256
   ```
   and update `url`/`sha256` to that version, then commit and push.
4. Verify: `brew install --build-from-source ./Formula/dahrk.rb && brew test dahrk`.

From then on the release workflow keeps it up to date (needs the `TAP_PUSH_TOKEN` secret, a PAT with
`repo` scope on `dahrkai/homebrew-tap`).
