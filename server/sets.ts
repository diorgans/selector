import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRekordboxXml, type SetList } from './exportXml.ts'
import { rawTracks } from './library.ts'

// Sets live in ~/.selector/sets.json; "Send to rekordbox" writes ~/Music/Selector.xml.
const SETS = process.env.SELECTOR_SETS ?? join(homedir(), '.selector', 'sets.json')
export const EXPORT_PATH = process.env.SELECTOR_EXPORT_XML ?? join(homedir(), 'Music', 'Selector.xml')

export async function loadSets(): Promise<SetList[]> {
  try {
    return JSON.parse(await readFile(SETS, 'utf8'))
  } catch {
    return []
  }
}

async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, text)
  await rename(`${path}.tmp`, path) // never leaves a half-written file behind
}

export async function saveSets(sets: SetList[]): Promise<void> {
  if (!Array.isArray(sets) || !sets.every((s) => typeof s?.id === 'string' && typeof s.name === 'string' && Array.isArray(s.trackIds)))
    throw new Error('Sets must be a list of { id, name, trackIds }.')
  await writeAtomic(SETS, JSON.stringify(sets, null, 2))
}

/** Save the given sets, then write them all for rekordbox (one step, so the file always matches what's on screen). */
export async function exportSets(current: SetList[]): Promise<{ path: string; sets: number; tracks: number }> {
  await saveSets(current)
  const sets = current.filter((s) => s.trackIds.length > 0)
  await writeAtomic(EXPORT_PATH, buildRekordboxXml(sets, await rawTracks()))
  return { path: EXPORT_PATH, sets: sets.length, tracks: sets.reduce((n, s) => n + s.trackIds.length, 0) }
}
