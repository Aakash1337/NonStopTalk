# Cloudflare deployment (Workers Free)

NonStopTalk has a native Cloudflare edition designed for the Workers Free plan. It does not run the Go server or use Cloudflare Containers.

The deployment consists of:

- Workers Static Assets serving `cloudflare/public`
- a TypeScript Worker handling `/api/*`
- one SQLite-backed Durable Object per six-character room code
- hibernatable WebSockets for live room updates

The Durable Object binding is internal. Players use the normal public Worker URL:

```text
https://nonstoptalk.<account-subdomain>.workers.dev/
https://nonstoptalk.<account-subdomain>.workers.dev/room/ABC123
```

## Cost and free limits

Cloudflare makes SQLite-backed Durable Objects available on Workers Free. As of August 2026, its published Durable Object daily allocation includes 100,000 requests and 13,000 GB-seconds of duration, plus 5 million SQLite rows read and 100,000 rows written per day and 5 GB of stored data. Workers Free also has a 100,000-request daily Worker limit. Static asset requests are free and unlimited.

This small party game is designed to stay inside those allocations: inactive objects do not accrue duration, and the WebSocket Hibernation API lets an idle room sleep without disconnecting its players. Workers Free does not silently begin paid overage billing. If a Durable Objects daily allocation is exhausted, further operations of that type fail until the allocation resets at 00:00 UTC. If the Worker's daily request allocation is exhausted, this deployment's `run_worker_first` `/api/*` requests receive `429 Too Many Requests`; asset-side requests continue to be served without invoking the Worker script. Cloudflare's separate fail-open/fail-closed behavior (origin bypass versus an Error 1027 page) applies to configurable zone Routes, not as an origin fallback for this `workers.dev` deployment. Confirm the current [Durable Objects pricing and limits][do-pricing], [Workers limits][worker-limits], [Static Assets billing][assets-billing], and [Worker routing options][worker-routing] before deployment.

The Worker also uses Cloudflare's built-in [Rate Limiting binding][rate-limit-binding] to allow at most ten room creations per source connection per minute in each Cloudflare location. This guard is intentionally generous for normal play and reduces trivial Free-plan quota abuse; Cloudflare documents these counters as permissive and eventually consistent, so it is not an accounting boundary or a defense against a distributed attack.

The optional Anthropic integration belongs to the local Go edition. The supplied Cloudflare edition uses classic scoring and does not require or accept an AI-provider secret.

## Requirements

- A Cloudflare account using Workers Free
- Node.js 22 or newer and npm
- Wrangler authentication (`npx wrangler login`) or a suitable Cloudflare API token in CI

Docker, a Cloudflare Container, and the Workers Paid plan are not required.

## Deploy from a terminal

From the repository root:

```sh
npm clean-install
npm run test:cloudflare
npm run check:cloudflare
npx wrangler login
npm run deploy
```

`npm run deploy` prints the resulting `workers.dev` URL. The configured Worker name is `nonstoptalk`.

`npm run check:cloudflare` performs a Wrangler dry run. It validates the TypeScript bundle, static asset discovery, Durable Object binding, and migration without changing a Cloudflare account.

`wrangler.jsonc` assigns the room-creation limiter namespace ID `6677867`. Rate-limiter namespace IDs are account-local positive integers. If another Worker in the same account already uses that value, choose a different integer to keep their counters independent.

## Deploy with Workers Builds

For the repository-connected flow in the Cloudflare dashboard:

1. Create or connect a **Worker** project, not a Pages-only static project.
2. Use the repository root (`/`) as the root directory.
3. Use Node.js 22 or newer (Node.js 24 is also supported).
4. Use `npm run test:cloudflare` as the optional build command.
5. Use `npm run deploy` as the deploy command.
6. Keep the Worker name aligned with `name` in `wrangler.jsonc` (`nonstoptalk` by default).

Workers Builds installs dependencies before running those commands. No build-output directory is needed because `wrangler.jsonc` explicitly points Static Assets at `cloudflare/public`.

## Develop the Cloudflare edition locally

```sh
npm clean-install
npm run dev
```

Wrangler starts the Worker, local Durable Object storage, and static assets. Its local state lives under `.wrangler`, which is ignored by Git.

The original Go edition is still the richer local app and remains available independently:

```sh
go run ./cmd/web
```

It listens on `http://localhost:8080` and keeps its JSON snapshot behavior. Running the Worker does not replace or reconfigure it.

## Room durability and retention

Each online room owns one Durable Object selected by its room code. The object stores the complete classic-game state as a row in its private SQLite database, so hibernation, Worker deployments, and ordinary process restarts do not erase an active room.

A room is deleted after 30 days without a state change. The alarm closes any remaining sockets and clears the object's storage. Browser identity is an unguessable, HTTP-only cookie; clearing that cookie loses the corresponding seat/host identity.

The free online edition currently mirrors the core room, setup, topic, microphone/manual timer, classic scoring, score override, standings, history, host transfer, and host-claim flows. It does not yet include the Go edition's AI judge, generated topics, saved presets, text import/export, microphone picker, or sound cues.

## Custom domain

The easiest custom-domain layout is a whole subdomain because the app uses root-relative `/api`, `/room`, and asset paths. Add a Custom Domain in the dashboard, or add a route like this to `wrangler.jsonc`:

```json
"routes": [
  {
    "pattern": "talk.example.com",
    "custom_domain": true
  }
]
```

The player URL then becomes `https://talk.example.com/room/ABC123`. Hosting it below a prefix such as `example.com/nonstoptalk/*` requires application path changes and is not currently supported.

## Why the original deployment failed

The earlier repository had neither a Wrangler entry point nor a declared static asset directory. A config-free `npx wrangler deploy` therefore failed with:

```text
Could not detect a directory containing static files
```

`wrangler.jsonc` now supplies all three stateful pieces Wrangler needs: the Worker entry point, the `cloudflare/public` asset directory, and the SQLite-backed Durable Object binding/migration. It is a Worker-with-Assets deployment rather than a Pages-only site.

## Durable Object migrations

The `v1` migration creates `RoomDurableObject` with the SQLite backend required by Workers Free. Do not edit or reuse an already-deployed migration tag. Future class renames or storage-class changes must add a new migration entry.

[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[worker-limits]: https://developers.cloudflare.com/workers/platform/limits/
[assets-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[worker-routing]: https://developers.cloudflare.com/workers/configuration/routing/
[rate-limit-binding]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
