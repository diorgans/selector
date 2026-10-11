import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Crate, Library, Track } from '../shared/types.ts'
import { parseAppleLibrary, type ApplePlaylist, type AppleSong } from './apple.ts'
import { parseRekordboxXml, type RawTrack, type RekordboxPlaylist } from './rekordbox.ts'

/** Lowercase, drop "(feat. …)", "[Remix]"-style tags and punctuation, so "Love & War (feat. X)" ≈ "love war". */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[([](feat|ft|with)\.?[^)\]]*[)\]]/g, '')
    .replace(/\b(feat|ft)\.?\s.*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
const songKey = (title: string, artist: string) => `${normalize(title)}|${normalize(artist)}`

export function buildLibrary(
  rb: { tracks: Track[]; playlists: RekordboxPlaylist[] },
  apple?: { songs: AppleSong[]; playlists: ApplePlaylist[] },
): Library {
  const tracks = rb.tracks.map((t) => ({ ...t, crates: [] as string[] }))
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const crates: Crate[] = []

  for (const p of rb.playlists) {
    const ids = p.trackIds.filter((id) => byId.has(id))
    crates.push({ id: `rb:${p.path.join('/')}`, name: p.path.join(' / '), origin: 'rekordbox', trackIds: ids, totalItems: p.trackIds.length })
  }

  let appleMatched = 0
  if (apple) {
    // Each Apple song → the rekordbox track with the same artist + title (closest length wins).
    const rbByKey = new Map<string, Track[]>()
    for (const t of tracks) {
      const k = songKey(t.title, t.artist)
      rbByKey.set(k, [...(rbByKey.get(k) ?? []), t])
    }
    const match = new Map<string, Track>()
    for (const s of apple.songs) {
      const options = rbByKey.get(songKey(s.title, s.artist))
      if (!options) continue
      match.set(s.pid, options.reduce((a, b) => (Math.abs(b.durationSec - s.durationSec) < Math.abs(a.durationSec - s.durationSec) ? b : a)))
    }
    appleMatched = new Set([...match.values()].map((t) => t.id)).size
    for (const p of apple.playlists) {
      const ids = [...new Set(p.songPids.map((pid) => match.get(pid)?.id).filter((x): x is string => !!x))]
      crates.push({ id: `am:${p.id}`, name: p.name, origin: 'apple', trackIds: ids, totalItems: p.songPids.length })
    }
  }

  for (const c of crates) for (const id of c.trackIds) byId.get(id)!.crates.push(c.id)

  return {
    tracks,
    crates: crates.filter((c) => c.totalItems > 0),
    stats: {
      tracks: tracks.length,
      analyzed: tracks.filter((t) => t.bpm && t.key).length,
      streaming: tracks.filter((t) => t.source === 'streaming').length,
      files: tracks.filter((t) => t.source === 'file').length,
      appleMatched,
    },
    importedAt: new Date().toISOString(),
  }
}

// --- Loading from disk, re-reading only when an export changes ----------------

export const paths = {
  rekordbox: process.env.SELECTOR_REKORDBOX_XML ?? join(homedir(), 'Music', 'rekordbox.xml'),
  apple: process.env.SELECTOR_APPLE_XML ?? join(homedir(), 'Music', 'Apple Music Library.xml'),
}

let cache: { key: string; library: Library; raw: Map<string, RawTrack> } | undefined

async function mtime(path: string) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

export async function loadLibrary(): Promise<Library> {
  const [rbTime, appleTime] = await Promise.all([mtime(paths.rekordbox), mtime(paths.apple)])
  if (rbTime === null) throw new Error(`No rekordbox export at ${paths.rekordbox}. In rekordbox: File › Export Collection in xml format.`)
  const key = `${rbTime}:${appleTime}`
  if (cache?.key === key) return cache.library
  const rb = parseRekordboxXml(await readFile(paths.rekordbox, 'utf8'))
  const apple = appleTime === null ? undefined : parseAppleLibrary(await readFile(paths.apple, 'utf8'))
  cache = { key, library: buildLibrary(rb, apple), raw: rb.raw }
  return cache.library
}

/** rekordbox's own record of each track, for writing playlists it will recognise. */
export async function rawTracks(): Promise<Map<string, RawTrack>> {
  await loadLibrary()
  return cache!.raw
}
