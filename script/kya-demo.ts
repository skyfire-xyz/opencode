#!/usr/bin/env bun

const root = new URL("..", import.meta.url).pathname
const opencodeDir = new URL("../packages/opencode", import.meta.url).pathname

if (!(await Bun.file(new URL("../packages/opencode/node_modules/@opencode-ai/core/package.json", import.meta.url)).exists())) {
  console.error("OpenCode workspace dependencies are not installed.")
  console.error("Run from the repo root: bun install --ignore-scripts")
  process.exit(1)
}

const processes = [
  {
    name: "mock-kya",
    cwd: root,
    cmd: ["bun", "run", "packages/opencode/script/mock-mcp-kya-server.ts"],
  },
  {
    name: "opencode",
    cwd: opencodeDir,
    cmd: ["bun", "dev", "serve", "--port", "4096", "--log-level", "DEBUG", "--print-logs"],
  },
].map((processInfo) => ({
  ...processInfo,
  process: Bun.spawn(processInfo.cmd, {
    cwd: processInfo.cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }),
}))

console.log("KYA demo started")
console.log("mock MCP:   http://127.0.0.1:8787/mcp")
console.log("mock OAuth: http://127.0.0.1:8788")
console.log("OpenCode:   http://localhost:4096")
console.log("")
console.log("Press Ctrl-C to stop all demo processes.")

let shuttingDown = false

async function shutdown(code: number) {
  if (shuttingDown) return
  shuttingDown = true

  for (const item of processes) {
    item.process.kill()
  }

  await Promise.allSettled(processes.map((item) => item.process.exited))
  process.exit(code)
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}; stopping KYA demo...`)
    shutdown(0)
  })
}

for (const item of processes) {
  item.process.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`${item.name} exited with code ${code}; stopping KYA demo...`)
      shutdown(code ?? 1)
    }
  })
}

await new Promise(() => {})
