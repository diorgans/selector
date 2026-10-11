import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// The local server: routes under /api run in Node, on Noah's Mac only.
function localApi(): Plugin {
  return {
    name: 'selector-api',
    configureServer(server) {
      server.middlewares.use('/api/library', async (_req, res) => {
        try {
          const { loadLibrary } = await server.ssrLoadModule('/server/library.ts')
          const library = await loadLibrary()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(library))
        } catch (err) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Expose .env.local (e.g. ANTHROPIC_API_KEY) to the local server only.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return { plugins: [react(), localApi()] }
})
