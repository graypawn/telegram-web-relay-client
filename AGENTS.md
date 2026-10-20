# Upstream Synchronization

This client is a relay-specific derivative of `Ajaxy/telegram-tt`. It keeps Telegram-tt's browser UI and state model, but routes Telegram operations through the companion relay over Socket.IO instead of connecting to Telegram directly from the browser.

## Patch stack

- `.upstream.json` is the source of truth for the currently integrated Telegram-tt revision and version.
- The historical relay adaptation is represented as a source patch followed by a separate tracked-`dist/` artifact patch. Keep these concerns separate in future integrations.
- `main` has an upstream ancestry bridge. Update it through review branches and merge commits rather than rewriting public history.
- Do not force-push `main`. Prepare a review branch for every upstream integration.

## Updating from Telegram-tt

1. Run `node scripts/check-telegram-tt-upstream.mjs` or inspect the scheduled workflow report to select a specific upstream commit or release.
2. Fetch the selected revision from the `telegram-tt` remote and create an integration branch from `main`.
3. Merge the selected upstream revision with a non-fast-forward merge. Resolve source conflicts before considering generated files.
4. Preserve the relay transport boundary. Do not restore browser-owned MTProto authentication, sessions, or direct Telegram network connections.
5. Regenerate and verify `dist/` only after the source integration is complete. Do not resolve generated artifact conflicts by manually combining bundled files.
6. Validate relay login, updates, media upload/download, and reconnect behavior in addition to applicable build and type checks.
7. Update `.upstream.json` in the same integration commit with the adopted revision, version, and integration commit.

## Relay-owned boundaries

- `src/api/socket/` and `src/api/tdlib/` implement relay transport and TDLib-compatible conversion.
- Changes around `src/global/actions/api/`, `src/global/actions/apiUpdaters/`, `src/global/reducers/`, and `src/global/types/` may bridge relay events into the Telegram-tt state model.
- Treat upstream changes in these paths as semantic conflicts: retain relay behavior while porting compatible UI/state changes. Do not choose either side wholesale.
- UI-only components, styles, localization, and isolated utilities are usually safer candidates for selective upstream adoption.

## Provenance and review

- Prefer `git cherry-pick -x` for isolated upstream fixes so their origin remains discoverable.
- Record the adopted upstream commit or release in the integration PR description.
- Keep client release version bumps separate from upstream code integration when possible.
