import { expect, test } from "bun:test"
import { services } from "../../../../script/kya-dev"

test("runs app, opencode server, and merchant MCP services", () => {
  expect(services.map((service) => service.name)).toEqual(["app", "opencode", "merchant"])
  expect(services.map((service) => service.cmd)).toEqual([
    ["bun", "run", "--cwd", "packages/app", "dev"],
    ["bun", "dev", "serve", "--port", "4096", "--log-level", "DEBUG", "--print-logs"],
    ["npm", "start"],
  ])
  expect(services.map((service) => service.cwd)).toEqual([".", "packages/opencode", "merchant-mcp"])
})
