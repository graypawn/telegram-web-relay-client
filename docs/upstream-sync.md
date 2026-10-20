# Telegram-tt Upstream Synchronization

This client is a relay-specific derivative of [Telegram-tt](https://github.com/Ajaxy/telegram-tt). Telegram-tt maintenance is a source of browser compatibility, security, UI, and Telegram API fixes, but its direct browser-to-Telegram transport must not replace the relay transport.

## Policy

- Check upstream weekly with the `Check Telegram-tt upstream` workflow or `node scripts/check-telegram-tt-upstream.mjs`.
- Treat an upstream version change as an integration candidate, not an automatic update.
- Adopt security and compatibility fixes promptly. Review UI and isolated utility changes selectively.
- Keep relay transport, authentication ownership, session handling, and update delivery under this project's control.
- Use one integration branch and pull request per selected upstream revision or small release range.

## Integration workflow

1. Read `.upstream.json` and the upstream report to identify the current integrated revision and the target revision.
2. Register and fetch the upstream remote when it is absent:

   ```sh
   git remote add telegram-tt https://github.com/Ajaxy/telegram-tt.git
   git fetch --no-tags telegram-tt master
   ```

   When the remote already exists, only run the fetch command.

3. Create `upstream-sync/<target-version>` from current `main`.
4. Merge the target revision with `--no-ff`. Resolve source conflicts according to `AGENTS.md`.
5. Regenerate `dist/`; never manually combine generated bundle output during conflict resolution.
6. Run the applicable checks in Docker and validate relay login, updates, media upload/download, and reconnect behavior.
7. Update `.upstream.json` with the adopted upstream revision, version, date, and integration commit in the same pull request.

## Review checklist

- The browser still uses Socket.IO relay transport and does not own a Telegram session.
- Upstream API/type changes are reflected in relay conversion and event handling where required.
- Generated artifacts were rebuilt, not hand-merged.
- The pull request links the upstream comparison URL and records any intentionally skipped changes.
