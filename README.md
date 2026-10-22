# telegram-web-relay-client

> **AI-assisted fork:** Changes in this fork were made with AI-assisted development tools.

Relay-specific fork of [Telegram Web A / Telegram-tt](https://github.com/Ajaxy/telegram-tt).

This browser client is adapted to run against the companion [telegram-web-relay](https://github.com/graypawn/telegram-web-relay) server: Telegram connectivity is owned by the relay over TDLib, and the browser talks to it over HTTP and Socket.IO instead of connecting to Telegram directly.

**Fork lineage**

```
Telegram Web A (Telegram-tt)  ← upstream
    ↑ fork
lisyoen/telegram-web-relay-client
    ↑ fork
graypawn/telegram-web-relay-client  ← this repository
```

**Related repositories**

| Repository | Role | License |
| --- | --- | --- |
| [`graypawn/telegram-web-relay-client`](https://github.com/graypawn/telegram-web-relay-client) | Browser UI adapted for the Socket.IO relay | GPL-3.0-or-later |
| [`graypawn/telegram-web-relay`](https://github.com/graypawn/telegram-web-relay) | Node.js TDLib relay server that hosts the UI | MIT |
| [`lisyoen/telegram-web-relay-client`](https://github.com/lisyoen/telegram-web-relay-client) | Original relay client fork | GPL-3.0-or-later |
| [`lisyoen/telegram-web-relay`](https://github.com/lisyoen/telegram-web-relay) | Original TDLib relay server | MIT |
| [`Ajaxy/telegram-tt`](https://github.com/Ajaxy/telegram-tt) | Telegram Web A (upstream) | GPL-3.0-or-later |

## What changes versus upstream

This fork keeps Telegram-tt's browser UI and state model, but replaces its direct browser-to-Telegram transport:

- Telegram operations travel over Socket.IO to the relay server instead of an in-browser MTProto connection.
- The browser does not own a Telegram session, authentication, or downloaded file cache for account data; the relay does.
- TDLib-compatible conversion and relay event bridging live under `src/api/tdlib/` and `src/api/socket/`.

The full integration policy is in [AGENTS.md](./AGENTS.md) and [docs/upstream-sync.md](./docs/upstream-sync.md).

## Local setup

The client expects a running relay. See the [relay server README](https://github.com/graypawn/telegram-web-relay) for Docker deployment and configuration.

For UI development against a local relay:

```sh
npm i
npm run dev
```

Obtain API ID and API hash on [my.telegram.org](https://my.telegram.org) and configure them on the **relay server**, not in the browser.

## Upstream project

This project originated from [Telegram Web A](https://web.telegram.org/a), which won the first prize at the [Telegram Lightweight Client Contest](https://contest.com/javascript-web-3). It is based on Telegram-tt's own [Teact](https://github.com/Ajaxy/teact) framework and bundles a custom version of [GramJS](https://github.com/gram-js/gramjs).

Upstream README details, dependency list, and bug-report guidance: [Ajaxy/telegram-tt](https://github.com/Ajaxy/telegram-tt#readme).

## License

[GPL-3.0-or-later](./LICENSE).

Copyright remains with the original Telegram-tt authors and contributors; relay-specific modifications are distributed under the same license.
