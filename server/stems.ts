import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audioPath } from './library.ts'

// Stem separation jobs. Demucs runs in ~/.selector/py (installed once), one
// song at a time, and results are cached in ~/.selector/stems/<track id>/.

export const STEM_PARTS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemPart = (typeof STEM_PARTS)[number]
export type StemStatus = { state: 'none' | 'queued' | 'running' | 'ready' | 'error'; stage?: string; progress?: number; message?: string }

const PY = process.env.SELECTOR_PYTHON ?? join(homedir(), '.selector', 'py', 'bin', 'python')
const ROOT = process.env.SELECTOR_STEMS_DIR ?? join(homedir(), '.selector', 'stems')
const SCRIPT = fileURLToPath(new URL('./stems.py', import.meta.url))

const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')
const dirFor = (id: string) => join(ROOT, safe(id))

const jobs = new Map<string, StemStatus>()
const queue: string[] = []
let busy = false

export function stemsInstalled() {
  return existsSync(PY)
}

export function stemStatus(id: string): StemStatus {
  if (existsSync(join(dirFor(id), 'done.json'))) return { state: 'ready' }
  return jobs.get(id) ?? { state: 'none' }
}

export async function requestStems(id: string): Promise<StemStatus> {
  const now = stemStatus(id)
  if (now.state === 'ready' || now.state === 'queued' || now.state === 'running') return now
  if (!stemsInstalled()) throw new Error('Stem separation isn’t installed (expected Python at ~/.selector/py).')
  if (!(await audioPath(id))) throw new Error('Only music files you own can be split into stems.')
  jobs.set(id, busy ? { state: 'queued' } : { state: 'running', stage: 'starting', progress: 0 })
  queue.push(id)
  void runNext()
  return jobs.get(id)!
}

async function runNext() {
  if (busy) return
  const id = queue.shift()
  if (!id) return
  busy = true
  const input = await audioPath(id)
  const out = dirFor(id)
  try {
    if (!input) throw new Error('File not found (drive unplugged?).')
    await rm(out, { recursive: true, force: true })
    jobs.set(id, { state: 'running', stage: 'starting', progress: 0 })
    await new Promise<void>((resolve, reject) => {
      const child = spawn(PY, [SCRIPT, input, out], { env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' } })
      let errText = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          const [word, value] = line.trim().split(/\s+/)
          const cur = jobs.get(id)!
          if (word === 'STAGE') jobs.set(id, { ...cur, stage: value })
          if (word === 'PROGRESS') jobs.set(id, { ...cur, progress: Number(value) })
        }
      })
      child.stderr.setEncoding('utf8').on('data', (c: string) => (errText = (errText + c).slice(-2000)))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errText.trim().split('\n').pop() || `Demucs exited with ${code}`))))
    })
    jobs.delete(id) // done.json now marks it ready
  } catch (err) {
    jobs.set(id, { state: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    busy = false
    void runNext()
  }
}

/** Path to one cached stem file, or null if it isn't ready (part names are whitelisted). */
export async function stemPath(id: string, part: string): Promise<string | null> {
  if (!STEM_PARTS.includes(part as StemPart) || stemStatus(id).state !== 'ready') return null
  const p = join(dirFor(id), `${part}.flac`)
  return existsSync(p) ? p : null
}

export async function stemInfo(id: string) {
  try {
    return JSON.parse(await readFile(join(dirFor(id), 'done.json'), 'utf8'))
  } catch {
    return null
  }
}
