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
      route(server, '/api/export', { POST: async (body, s) => (await load(s, '/server/sets.ts')).exportSets(body) })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Expose .env.local (e.g. ANTHROPIC_API_KEY) to the local server only.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return { plugins: [react(), localApi()] }
})
