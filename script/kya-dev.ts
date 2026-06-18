#!/usr/bin/env bun

import path from "path"

export const services = [
  {
    name: "app",
    cwd: ".",
    cmd: ["bun", "run", "--cwd", "packages/app", "dev"],
  },
  {
    name: "opencode",
    cwd: "packages/opencode",
    cmd: ["bun", "dev", "serve", "--port", "4096", "--log-level", "DEBUG", "--print-logs"],
  },
  {
    name: "merchant",
    cwd: "merchant-mcp",
    cmd: ["npm", "start"],
  },
] as const

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname
  const processes = services.map((service) => {
    const child = Bun.spawn([...service.cmd], {
      cwd: service.cwd === "." ? root : path.join(root, service.cwd),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    })

    pipeOutput(service.name, child.stdout, process.stdout)
    pipeOutput(service.name, child.stderr, process.stderr)

    return { service, child }
  })

  console.log("KYA dev stack started")
  console.log("app:      packages/app dev")
  console.log("opencode: http://localhost:4096")
  console.log("merchant: http://127.0.0.1:8787/mcp")
  console.log("")
  console.log("Press Ctrl-C to stop all services.")

  let shuttingDown = false

  async function shutdown(code: number) {
    if (shuttingDown) return
    shuttingDown = true

    for (const item of processes) {
      item.child.kill()
    }

    await Promise.allSettled(processes.map((item) => item.child.exited))
    process.exit(code)
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`\nReceived ${signal}; stopping KYA dev stack...`)
      shutdown(0)
    })
  }

  for (const item of processes) {
    item.child.exited.then((code) => {
      if (!shuttingDown) {
        console.error(`${item.service.name} exited with code ${code}; stopping KYA dev stack...`)
        shutdown(code ?? 1)
      }
    })
  }

  await new Promise(() => {})
}

function pipeOutput(name: string, stream: ReadableStream<Uint8Array>, output: NodeJS.WriteStream) {
  const decoder = new TextDecoder()
  let pending = ""

  stream
    .pipeTo(
      new WritableStream({
        write(chunk) {
          pending += decoder.decode(chunk, { stream: true })
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ""
          for (const line of lines) {
            output.write(`[${name}] ${line}\n`)
          }
        },
        close() {
          pending += decoder.decode()
          if (pending) output.write(`[${name}] ${pending}\n`)
        },
      }),
    )
    .catch(() => {})
}
