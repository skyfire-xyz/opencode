# Deploying the opencode demo on Render (step 1: issuer only)

This deploys **one Render web service** running `opencode serve`, which serves both
the instance API and our embedded web UI from the same origin. Step 1 wires only
the **Skyfire issuer** (api-key auth) — enough to prove the infra end-to-end before
adding the merchant + KYA flow.

## Topology

```
browser ──HTTPS──▶ Render web service (opencode serve)
                     ├─ serves the embedded SPA (our fork, incl. KYA modal)
                     ├─ instance API (sessions, MCP, etc.)  ← app calls location.origin
                     └─ connects out to https://mcp-qa.skyfire.xyz/mcp (issuer, api-key)
```

The app defaults to `location.origin` for its server in production, so being served
by the same process means no separate static site and no CORS config.

## Files

- `deploy/Dockerfile` — multi-stage build. Compiles a self-contained binary with the
  SPA embedded (so our changes ship, not the upstream `app.opencode.ai` UI), then runs
  `opencode serve --hostname 0.0.0.0 --port $PORT`.
- `deploy/render.yaml` — Render Blueprint: the service, disk, and env vars.

## Steps

1. Push this fork to a Git repo Render can read.
2. Render → **New → Blueprint** and pick the repo (it reads `deploy/render.yaml`).
   (Or **New → Web Service**, runtime **Docker**, Dockerfile `./deploy/Dockerfile`, context `.`.)
3. Set the secret env vars (marked `sync: false`):
   - `SKYFIRE_API_KEY` — your Skyfire QA key (resolves `{env:SKYFIRE_API_KEY}` in the config).
   - `OPENCODE_SERVER_PASSWORD` — any password. Locks the server behind HTTP Basic auth
     (username `opencode`). **Set this** — an open server can drive the agent and mint
     wallet-deducting PAY tokens.
   - _(optional)_ a provider key like `ANTHROPIC_API_KEY` — **not required**: opencode
     serves free models by default (no key → free-tier models only, via the `"public"`
     opencode provider). Add a provider key only for paid/higher-quality models.
4. Deploy. The Docker build is heavy (bun install + SPA build + binary compile) — first
   build can take several minutes.
5. Open the service URL → browser prompts for Basic auth (`opencode` / your password) →
   the opencode web UI loads.

## Verifying step 1

- In the UI, open the MCP servers panel and **enable `skyfire`** → status should go
  **connected** (proves the api-key header auth + outbound reachability to QA).
- Send a prompt to confirm a model responds (free-tier opencode models work with no key;
  add a provider key for paid models).

The issuer's tools are intentionally hidden from the agent (it's a provider), so KYA
is **not** exercised yet — that comes when we add the merchant service.

## Known caveats / next steps

- **Arch**: `--single` builds for the build host's arch. Render builds on amd64 → a
  `linux-x64` binary that runs on Render's amd64 instances. If you build the image
  locally on an ARM Mac to push, use `docker build --platform linux/amd64`.
- **Workspace**: the agent operates on `/workspace` (empty in the container). Bake in or
  clone a repo if you want it to work on real files.
- **Runtime base**: uses `oven/bun:1.3.14-slim` for guaranteed glibc/libs. Can be slimmed
  to `debian:bookworm-slim` (+ `libstdc++6`) later if image size matters.
- **No health check path is set** (the UI root is behind Basic auth, which a health probe
  can't pass); Render falls back to a port-open check.
- **Step 2 (merchant)**: the merchant runs two listeners on two localhost ports with
  hardcoded `127.0.0.1` origins — it needs a small change (merge to one `$PORT`, use
  `RENDER_EXTERNAL_URL` as the public origin) to run as its own Render service. Then add
  it to `OPENCODE_CONFIG_CONTENT` with `"url": "{env:MERCHANT_URL}"`.
