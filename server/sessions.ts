import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '../shared/session.ts'

// Recorded DJ sessions, one JSON file each in ~/.selector/sessions.
const DIR = process.env.SELECTOR_SESSIONS_DIR ?? join(homedir(), '.selector', 'sessions')
const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')

export async function listSessions(): Promise<Session[]> {
  let files: string[] = []
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(DIR, f), 'utf8')) as Session))
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

export async function saveSession(s: Session): Promise<{ ok: true }> {
  if (!s || typeof s.id !== 'string' || !safe(s.id) || !Array.isArray(s.tracks) || typeof s.startedAt !== 'number')
    throw new Error('Not a session.')
  await mkdir(DIR, { recursive: true })
  const path = join(DIR, `${safe(s.id)}.json`)
  // A unique temp name per save, so two quick saves of one session can't collide.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2))
  await rename(tmp, path)
  return { ok: true }
}
