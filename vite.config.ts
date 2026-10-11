import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'

// The local server: routes under /api run in Node, on Noah's Mac only.
type Handler = (body: unknown, server: ViteDevServer) => Promise<unknown>

function route(server: ViteDevServer, path: string, methods: Record<string, Handler>) {
  server.middlewares.use(path, async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, data: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(data))
    }
    const handler = methods[req.method ?? 'GET']
    if (!handler) return send(405, { error: 'Method not allowed' })
    try {
      let body: unknown
      if (req.method !== 'GET') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      }
      send(200, await handler(body, server))
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  })
}

const load = (server: ViteDevServer, mod: string) => server.ssrLoadModule(mod)

function localApi(): Plugin {
  return {
    name: 'selector-api',
    configureServer(server) {
      route(server, '/api/library', { GET: async (_b, s) => (await load(s, '/server/library.ts')).loadLibrary() })
      route(server, '/api/sets', {
        GET: async (_b, s) => (await load(s, '/server/sets.ts')).loadSets(),
        PUT: async (body, s) => ((await (await load(s, '/server/sets.ts')).saveSets(body)), { ok: true }),
      })
      // Audio for one library track (?id=...). Only paths the library knows are served.
      server.middlewares.use('/api/audio', async (req, res) => {
        try {
          const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? ''
          const path = await (await load(server, '/server/library.ts')).audioPath(id)
          if (!path) {
            res.statusCode = 404
            return res.end('Not a playable library track')
          }
          await (await load(server, '/server/files.ts')).serveAudio(path, req, res)
        } catch (err) {
          res.statusCode = 500
          res.end(err instanceof Error ? err.message : String(err))
        }
      })
      // Stems: GET ?id= → status; POST ?id= → start splitting. /api/stem?id=&part= serves one stem.
      server.middlewares.use('/api/stems', async (req, res) => {
        const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? ''
        res.setHeader('Content-Type', 'application/json')
        try {
          const stems = await load(server, '/server/stems.ts')
          const status = req.method === 'POST' ? await stems.requestStems(id) : stems.stemStatus(id)
          res.end(JSON.stringify({ ...status, installed: stems.stemsInstalled() }))
        } catch (err) {
          res.statusCode = 400
          res.end(JSON.stringify({ state: 'error', message: err instanceof Error ? err.message : String(err) }))
        }
      })
      server.middlewares.use('/api/stem', async (req, res) => {
        const q = new URL(req.url ?? '', 'http://x').searchParams
        const path = await (await load(server, '/server/stems.ts')).stemPath(q.get('id') ?? '', q.get('part') ?? '')
        if (!path) {
          res.statusCode = 404
          return res.end('Stem not ready')
        }
        await (await load(server, '/server/files.ts')).serveAudio(path, req, res)
      })
      route(server, '/api/sessions', {
        GET: async (_b, s) => (await load(s, '/server/sessions.ts')).listSessions(),
        PUT: async (body, s) => (await load(s, '/server/sessions.ts')).saveSession(body),
      })
      route(server, '/api/export', { POST: async (body, s) => (await load(s, '/server/sets.ts')).exportSets(body) })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Expose .env.local (e.g. ANTHROPIC_API_KEY) to the local server only.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return { plugins: [react(), localApi()] }
})
