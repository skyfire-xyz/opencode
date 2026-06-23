#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Launcher: starts the auth server (auth-server.js) and the MCP resource
// (mcp-server.js) together in one terminal, with prefixed/colorized output and
// coordinated shutdown. No external dependency — just child_process.
//
//   node dev.js   (or: npm run dev)
//
// Ctrl-C (SIGINT) tears down both children. If either child exits, the other is
// stopped too so you never end up with a half-running pair.
// ---------------------------------------------------------------------------

import { spawn } from "child_process"
import process from "process"

const children = [
  { name: "auth", file: "auth-server.js", color: "\x1b[36m" }, // cyan
  { name: "mcp", file: "mcp-server.js", color: "\x1b[35m" }, // magenta
]
const RESET = "\x1b[0m"
// Pad names so the prefixes line up.
const width = Math.max(...children.map((c) => c.name.length))

let shuttingDown = false

function prefixStream(stream, name, color) {
  let buffer = ""
  stream.on("data", (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    // Keep the last partial line in the buffer until its newline arrives.
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      process.stdout.write(`${color}[${name.padEnd(width)}]${RESET} ${line}\n`)
    }
  })
}

const procs = children.map((child) => {
  const proc = spawn(process.execPath, [child.file], {
    cwd: import.meta.dirname,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  })
  prefixStream(proc.stdout, child.name, child.color)
  prefixStream(proc.stderr, child.name, child.color)

  proc.on("exit", (code, signal) => {
    process.stdout.write(`${child.color}[${child.name.padEnd(width)}]${RESET} exited (code=${code}, signal=${signal})\n`)
    // First child to exit triggers teardown of the rest.
    if (!shuttingDown) shutdown(code ?? 0)
  })

  return { ...child, proc }
})

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { proc } of procs) {
    if (!proc.killed) proc.kill("SIGTERM")
  }
  // Give children a moment to clean up, then exit the launcher.
  setTimeout(() => process.exit(code), 300)
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

console.log(`[launcher] starting ${procs.map((p) => p.name).join(" + ")} (Ctrl-C to stop both)`)
