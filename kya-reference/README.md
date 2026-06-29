# KYA Reference

Technical specification and reference mock servers for the **KYA (Know Your Agent) +
OAuth + MCP** integration — an autonomous agent exchanging a signed KYA assertion for
an OAuth access token to reach a protected MCP server, with interactive OAuth as the
fallback.

## Layout

```
docs/                         Specification & operations docs
  KYA-TECH-SPEC.md            Technical specification (design reference)
  KYA-TECH-SPEC.html          Pre-rendered HTML of the spec
  KYA.md                      Operations runbook
  kya+oauth+sequence+diagram.png

merchant-mcp/                 Reference protected MCP resource server (+ flow/verify scripts)
xyz-clothiers-mock/           Mock MCP server + mock OAuth authorization server
```

## Install

This is an npm workspaces repo — one install at the root covers both mock packages:

```sh
npm install
```

## Run

From the repo root:

| Command              | What it runs                                                        |
| -------------------- | ------------------------------------------------------------------- |
| `npm run mock`       | XYZ Clothiers mock: MCP server **and** mock auth server together    |
| `npm run mock:server`| XYZ Clothiers MCP server only                                       |
| `npm run mock:auth`  | Mock OAuth authorization server only                                |
| `npm run merchant`   | Merchant reference MCP resource server                              |

Each package can also be run directly (e.g. `npm start -w xyz-clothiers-mock`). See the
per-package `README.md` files for ports, environment variables, and details.
