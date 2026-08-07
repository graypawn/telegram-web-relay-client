# Dist Release

The current release workflow builds the browser client and publishes a zip archive of `dist/`.

## GitHub Settings

Set this repository variable under Settings -> Secrets and variables -> Actions -> Variables:

- `NODE_VERSION`: `22`

The workflow publishes to the current repository automatically using `github.repository` and the built-in `GITHUB_TOKEN`. It does not use a Gist, Tauri signing keys, or platform signing certificates.

## Release

1. Update `package.json` version.
2. Push the change to `main`.
3. GitHub Actions runs `Package and publish dist`.
4. The workflow builds `dist/` and publishes `telegram-relay-client-<version>-dist.zip`.
5. The installer downloads and extracts the archive into the relay's `dist/` directory.

The archive contains the contents of `dist/` directly, not an extra enclosing `dist` directory.
