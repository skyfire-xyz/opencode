# syntax=docker/dockerfile:1
#
# Build a self-contained opencode binary with our forked web UI embedded, then
# run it headless. The server serves BOTH the instance API and the SPA, so the
# browser app talks back to the same origin (no separate static site, no CORS).

# ---- build stage ----------------------------------------------------------
FROM oven/bun:1.3.14 AS build
WORKDIR /src
COPY . .
# Install monorepo deps. --ignore-scripts skips native postinstall builds
# (tree-sitter grammars, node-pty) that need a node-gyp toolchain and aren't
# required for a headless server; script/build.ts pulls the native deps it does
# need (@opentui/core, @parcel/watcher) as prebuilt binaries.
RUN bun install --ignore-scripts
# Version/channel for the build. Setting these avoids the script's `git` fallback
# (the build context has no .git) and the npm "latest" lookup.
ENV OPENCODE_CHANNEL=latest \
    OPENCODE_VERSION=0.0.0
# Compile a single-platform binary. script/build.ts --single also runs
# `packages/app build` and embeds the built SPA into the binary
# (opencode-web-ui.gen.ts) — so OUR KYA changes ship, instead of the server
# proxying the upstream app.opencode.ai UI.
RUN cd packages/opencode && bun run script/build.ts --single

# ---- runtime stage ---------------------------------------------------------
FROM oven/bun:1.3.14-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The compiled binary bundles the Bun runtime + embedded UI; just copy it.
# (--single builds exactly one linux target, so the glob resolves to one file.)
COPY --from=build /src/packages/opencode/dist/opencode-linux-*/bin/opencode /usr/local/bin/opencode
RUN chmod +x /usr/local/bin/opencode
# Writable HOME for opencode's data/config (mcp-auth.json, sessions, KYA tokens).
ENV HOME=/data
RUN mkdir -p /data /workspace
WORKDIR /workspace
# Render injects $PORT; bind all interfaces so it's externally reachable.
CMD ["sh", "-c", "opencode serve --hostname 0.0.0.0 --port \"${PORT:-10000}\""]
