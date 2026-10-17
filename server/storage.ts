import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

/**
 * Storage files: each Storage block writes to its own file in <project>/flows/storage, one line per
 * batch of data it received, labelled with the date and time it arrived (JSON Lines):
 *
 *   {"at":"2026-10-16T22:41:09.123Z","type":"list","data":[…]}
 *
 *   GET    /api/storage              → { stores: [{ name, entries, bytes, updatedAt }] }
 *   POST   /api/storage              → create the next storage_N (empty)
 *   GET    /api/storage/:name?last=N&since=T&max=M → the store's info plus its records, oldest first:
 *                                       the last N (0: all), stored at or after T (ms), and — when there
 *                                       are more than M — M of them spread evenly (always the first and newest)
 *   POST   /api/storage/:name        → append one record (body: { type, data, keep }); the date is added here.
 *                                       keep > 0: only the newest `keep` records are kept (older ones removed)
 *   PATCH  /api/storage/:name?keep=N → keep only the newest N records now
 *   DELETE /api/storage/:name?clear  → empty its history (without ?clear: delete the file)
 *
 * Appending never rewrites the file, so a long history stays cheap to add to.
 */
export function storageFiles(dir = 'flows/storage'): Plugin {
  let root = ''
  const NAME = /^[A-Za-z0-9_-]{1,64}$/
  const EXT = '.jsonl'
  const file = (name: string) => path.join(root, `${name}${EXT}`)

  /** Entry counts by store, so the info doesn't need the whole file read each time. */
  const counts = new Map<string, number>()
  /** Writes to one file happen one after another. */
  const queues = new Map<string, Promise<unknown>>()
  const queued = <T>(name: string, job: () => Promise<T>) => {
    const next = (queues.get(name) ?? Promise.resolve()).then(job, job)
    queues.set(name, next.catch(() => {}))
    return next
  }

  const countOf = async (name: string) => {
    if (!counts.has(name)) {
      const text = await fs.readFile(file(name), 'utf8')
      counts.set(name, text.split('\n').filter(Boolean).length)
    }
    return counts.get(name)!
  }

  /** Keep only the newest `keep` records — rewrites the file (atomically), so only when it's over. */
  const trim = async (name: string, keep: number) => {
    if (!(keep > 0) || (await countOf(name)) <= keep) return
    const lines = (await fs.readFile(file(name), 'utf8')).split('\n').filter(Boolean).slice(-keep)
    const tmp = `${file(name)}.tmp`
    await fs.writeFile(tmp, lines.map((l) => l + '\n').join(''))
    await fs.rename(tmp, file(name))
    counts.set(name, lines.length)
  }

  const info = async (name: string) => {
    const st = await fs.stat(file(name))
    return { name, entries: await countOf(name), bytes: st.size, updatedAt: st.mtime.toISOString() }
  }

  const names = async () => {
    await fs.mkdir(root, { recursive: true })
    return (await fs.readdir(root))
      .filter((f) => f.endsWith(EXT))
      .map((f) => f.slice(0, -EXT.length))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
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
    name: 'storage-files',
    configResolved(config) {
      root = path.resolve(config.root, dir)
    },
    configureServer(server) {
      server.middlewares.use('/api/storage', async (req, res) => {
        try {
          const [rawPath, query = ''] = (req.url ?? '/').split('?')
          const params = new URLSearchParams(query)
          const name = decodeURIComponent(rawPath.replace(/^\//, ''))

          if (!name) {
            if (req.method === 'GET') return send(res, 200, { stores: await Promise.all((await names()).map(info)) })
            if (req.method === 'POST') {
              const used = (await names()).map((n) => Number(n.match(/^storage_(\d+)$/)?.[1] ?? 0))
              const next = `storage_${Math.max(0, ...used) + 1}`
              await fs.writeFile(file(next), '', { flag: 'wx' })
              counts.set(next, 0)
              return send(res, 201, await info(next))
            }
            return send(res, 405, { error: 'Method not allowed' })
          }

          if (!NAME.test(name)) return send(res, 400, { error: 'Invalid storage name' })
          const exists = await fs.stat(file(name)).then(() => true, () => false)

          if (req.method === 'POST') {
            const { type, data, keep } = JSON.parse(await readBody(req))
            const line = JSON.stringify({ at: new Date().toISOString(), type, data }) + '\n'
            const result = await queued(name, async () => {
              await fs.mkdir(root, { recursive: true })
              // A store whose file was removed starts again from empty.
              const before = exists ? await countOf(name) : 0
              await fs.appendFile(file(name), line)
              counts.set(name, before + 1)
              await trim(name, Math.floor(Number(keep) || 0))
              return info(name)
            })
            return send(res, 200, result)
          }

          if (!exists) return send(res, 404, { error: `No storage named ${name}` })

          if (req.method === 'GET') {
            const last = Math.max(0, Number(params.get('last') ?? 50) || 0)
            const since = Number(params.get('since')) || 0
            const max = Math.max(0, Number(params.get('max')) || 0)
            let lines = (await fs.readFile(file(name), 'utf8')).split('\n').filter(Boolean)
            // Each line starts with its date ({"at":"…"), so a time filter needn't parse whole lines.
            if (since) lines = lines.filter((l) => Date.parse(l.match(/^\{"at":"([^"]+)"/)?.[1] ?? '') >= since)
            if (last) lines = lines.slice(-last)
            if (max > 1 && lines.length > max) {
              const all = lines
              lines = Array.from({ length: max }, (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))])
            }
            const records = lines.flatMap((l) => {
              try {
                return [JSON.parse(l)]
              } catch {
                return [] // a line cut short by a crash is skipped, not fatal
              }
            })
            return send(res, 200, { ...(await info(name)), records })
          }

          if (req.method === 'PATCH') {
            const keep = Math.floor(Number(params.get('keep')) || 0)
            return send(res, 200, await queued(name, async () => (await trim(name, keep), info(name))))
          }

          if (req.method === 'DELETE') {
            if (params.has('clear')) {
              await queued(name, async () => {
                await fs.writeFile(file(name), '')
                counts.set(name, 0)
              })
              return send(res, 200, await info(name))
            }
            await queued(name, () => fs.rm(file(name)))
            counts.delete(name)
            return send(res, 200, { ok: true })
          }
          return send(res, 405, { error: 'Method not allowed' })
        } catch (e) {
          send(res, 500, { error: (e as Error).message })
        }
      })
    },
  }
}
