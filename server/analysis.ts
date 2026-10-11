import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toCamelot } from '../shared/camelot.ts'
import type { Track } from '../shared/types.ts'

// BPM / key / first-beat analysis for music files that don't have them, with
// Essentia in ~/.selector/py. One Python process works through a queue; results
// are saved to ~/.selector/analysis.json (keyed by path + size + modified time),
// so each song is analysed once. Beat positions come from the kick drum (analyze.py).

const PY = process.env.SELECTOR_PYTHON ?? join(homedir(), '.selector', 'py', 'bin', 'python')
const STORE = process.env.SELECTOR_ANALYSIS ?? join(homedir(), '.selector', 'analysis.json')
const SCRIPT = fileURLToPath(new URL('./analyze.py', import.meta.url))

export type Analysis = { bpm: number; key: string | null; keyStrength: number; firstBeat: number; confidence: number; sig: string; error?: string }
export type AnalysisStatus = { running: boolean; total: number; done: number; failed: number; current?: string; startedAt?: number }

let store: Record<string, Analysis> | undefined
let status: AnalysisStatus = { running: false, total: 0, done: 0, failed: 0 }
let version = 0 // bumps when results change, so the library re-merges

/** Most dance tracks are made at a whole BPM; snap analysis that lands very close to one. */
export function tidyBpm(bpm: number): number {
  const r = Math.round(bpm)
  return Math.abs(bpm - r) <= 0.35 ? r : Math.round(bpm * 100) / 100
}

async function loadStore() {
  if (store) return store
  try {
    store = JSON.parse(await readFile(STORE, 'utf8'))
  } catch {
    store = {}
  }
  return store!
}

async function saveStore() {
  await mkdir(dirname(STORE), { recursive: true })
  const tmp = `${STORE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store))
  await rename(tmp, STORE)
}

const sigOf = async (path: string) => {
  const st = await stat(path)
  return `${st.size}:${Math.round(st.mtimeMs)}`
}

export const analysisVersion = () => version
export const analysisStatus = () => ({ ...status, installed: existsSync(PY) })

/** Fill missing BPM / key / first beat from saved analysis (tags and rekordbox data win). */
export async function applyAnalysis(tracks: Track[], pathOf: (t: Track) => string | null) {
  const s = await loadStore()
  for (const t of tracks) {
    const p = pathOf(t)
    const a = p ? s[p] : undefined
    if (!a || a.error) continue
    t.bpm ??= a.bpm
    t.key ??= a.key
    t.firstBeatSec ??= a.firstBeat
  }
}

/** Songs that still need analysing: playable files missing a BPM, key or beatgrid start. */
export async function pending(tracks: Track[], pathOf: (t: Track) => string | null) {
  const s = await loadStore()
  return tracks.filter((t) => {
    if (t.source !== 'file' || !t.playable) return false
    if (t.bpm && t.key && t.firstBeatSec !== undefined) return false
    const p = pathOf(t)
    return !!p && !s[p]
  })
}

let child: ChildProcessWithoutNullStreams | undefined

/** Analyse the given songs in the background (one at a time). Calling again while running is a no-op. */
export async function startAnalysis(jobs: { id: string; title: string; path: string }[]) {
  if (status.running) return analysisStatus()
  if (!existsSync(PY)) throw new Error('Analysis needs the Python environment in ~/.selector/py (with essentia).')
  const s = await loadStore()
  status = { running: true, total: jobs.length, done: 0, failed: 0, startedAt: Date.now() }
  if (!jobs.length) {
    status.running = false
    return analysisStatus()
  }
  const byId = new Map(jobs.map((j) => [j.id, j]))
  child = spawn(PY, [SCRIPT])
  let buf = ''
  let unsaved = 0
  const next = (i: number) => {
    const j = jobs[i]
    if (!j) return child?.stdin.end()
    status.current = j.title
    child?.stdin.write(JSON.stringify({ id: j.id, path: j.path }) + '\n')
  }
  let i = 0
  child.stdout.setEncoding('utf8').on('data', async (chunk: string) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const r = JSON.parse(line)
      const job = byId.get(r.id)
      if (job) {
        const sig = await sigOf(job.path).catch(() => '')
        s[job.path] = r.error
          ? { bpm: 0, key: null, keyStrength: 0, firstBeat: 0, confidence: 0, sig, error: r.error }
          : { bpm: tidyBpm(r.bpm), key: toCamelot(r.key + (r.scale === 'minor' ? 'm' : '')), keyStrength: r.keyStrength, firstBeat: r.firstBeat, confidence: r.confidence, sig }
        if (r.error) status.failed++
        status.done++
        version++
        if (++unsaved >= 10) {
          unsaved = 0
          await saveStore()
        }
      }
      next(++i)
    }
  })
  child.stderr.on('data', () => {}) // Essentia is chatty; errors come back per song on stdout
  child.on('close', async () => {
    await saveStore()
    status = { ...status, running: false, current: undefined }
    child = undefined
    version++
  })
  next(0)
  return analysisStatus()
}

export function stopAnalysis() {
  child?.kill()
  return analysisStatus()
}
