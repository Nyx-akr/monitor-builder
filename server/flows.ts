import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

/**
 * Stores flows as JSON files in <project>/flows, one file per flow (flow_1.json, flow_2.json, …).
 *
 *   GET  /api/flows          → { flows: ["flow_1", …] }
 *   GET  /api/flows/:name    → the flow
 *   PUT  /api/flows/:name    → save the flow
 *   POST /api/flows          → create the next flow_N (body: optional initial content)
 *
 * Dev-server only: a static build has no way to write files.
 */
export function flowFiles(dir = 'flows'): Plugin {
  let root = ''
  const NAME = /^[A-Za-z0-9_-]{1,64}$/
  const file = (name: string) => path.join(root, `${name}.json`)

  const list = async () => {
    await fs.mkdir(root, { recursive: true })
    const names = (await fs.readdir(root)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    // flow_2 before flow_10
    return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }

  const write = async (name: string, flow: unknown) => {
    const tmp = `${file(name)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(flow, null, 2) + '\n')
    await fs.rename(tmp, file(name)) // atomic: a crash never leaves half a file
  }

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })

  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  }

  return {
    name: 'flow-files',
    configResolved(config) {
      root = path.resolve(config.root, dir)
    },
    configureServer(server) {
      server.middlewares.use('/api/flows', async (req, res) => {
        try {
          const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''))

          if (!name) {
            if (req.method === 'GET') return send(res, 200, { flows: await list() })
            if (req.method === 'POST') {
              const existing = await list()
              const used = existing.map((n) => Number(n.match(/^flow_(\d+)$/)?.[1] ?? 0))
              const next = `flow_${Math.max(0, ...used) + 1}`
              const body = await readBody(req)
              const initial = body ? JSON.parse(body) : {}
              const flow = {
                version: 1,
                name: next,
                rev: 1,
                blocks: initial.blocks ?? [],
                wires: initial.wires ?? [],
                updatedAt: new Date().toISOString(),
              }
              await write(next, flow)
              return send(res, 201, flow)
            }
            return send(res, 405, { error: 'Method not allowed' })
          }

          if (!NAME.test(name)) return send(res, 400, { error: 'Invalid flow name' })

          if (req.method === 'GET') {
            try {
              return send(res, 200, JSON.parse(await fs.readFile(file(name), 'utf8')))
            } catch {
              return send(res, 404, { error: `No flow named ${name}` })
            }
          }
          if (req.method === 'PUT') {
            const { baseRev, ...flow } = JSON.parse(await readBody(req))
            const current = await fs
              .readFile(file(name), 'utf8')
              .then((t) => JSON.parse(t) as { rev?: number })
              .catch(() => null)
            const currentRev = current?.rev ?? 0
            if (process.env.DEBUG_FLOWS)
              console.log(`[flows] PUT ${name} base=${baseRev} cur=${currentRev} blocks=${flow.blocks?.length} wires=${flow.wires?.length} client=${req.headers['x-flow-client'] ?? '?'}`)
            // Optimistic concurrency: a save must build on the file's current revision, so a stale tab
            // (or a hot-reloaded instance) can never overwrite newer changes.
            if (current && baseRev !== currentRev) {
              return send(res, 409, { error: 'This flow was changed elsewhere (another tab?) — reload to get the latest', rev: currentRev })
            }
            const rev = currentRev + 1
            await fs.mkdir(root, { recursive: true })
            await write(name, { ...flow, version: 1, name, rev, updatedAt: new Date().toISOString() })
            return send(res, 200, { ok: true, rev })
          }
          return send(res, 405, { error: 'Method not allowed' })
        } catch (e) {
          send(res, 500, { error: (e as Error).message })
        }
      })
    },
  }
}
