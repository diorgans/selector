import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Crate, Library, Track } from '../shared/types.ts'
import { parseAppleLibrary, type ApplePlaylist, type AppleSong } from './apple.ts'
import { isProtected, locationToPath, scanFiles } from './files.ts'
import { analysisVersion, applyAnalysis } from './analysis.ts'
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
  files: Track[] = [],
): Library {
  // Scanned files rekordbox already knows (same path) aren't listed twice. Paths are
  // compared decoded, since rekordbox and Selector escape characters differently.
  const plain = (loc: string) => {
    try {
      return decodeURIComponent(loc).normalize('NFC')
    } catch {
      return loc
    }
  }
  const known = new Set(rb.tracks.map((t) => plain(t.location)))
  const tracks = [...rb.tracks, ...files.filter((f) => !known.has(plain(f.location)))].map((t) => ({ ...t, crates: [] as string[] }))
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
      playable: tracks.filter((t) => t.playable).length,
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

let cache: { key: string; library: Library; raw: Map<string, RawTrack>; paths: Map<string, string> } | undefined

async function mtime(path: string) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

let inflight: Promise<Library> | undefined

/** The library, re-read at most every 30 s (or now, with `force`). Concurrent callers share one scan. */
export async function loadLibrary(force = false): Promise<Library> {
  if (inflight) return inflight
  inflight = build(force).finally(() => (inflight = undefined))
  return inflight
}

// The exports are big (the Music library XML is ~20 MB): parse each only when its file changes.
let parsed: { rbTime: number | null; appleTime: number | null; rb: ReturnType<typeof parseRekordboxXml>; apple?: ReturnType<typeof parseAppleLibrary> } | undefined
let merged = { version: -1, at: 0 }

async function build(force: boolean): Promise<Library> {
  const [rbTime, appleTime] = await Promise.all([mtime(paths.rekordbox), mtime(paths.apple)])
  // Re-scan at most every 30 s so new downloads and a plugged-in drive show up without a restart.
  // New analysis results re-merge at most every 15 s while a batch runs.
  const v = analysisVersion()
  const analysisDue = v !== merged.version && Date.now() - merged.at > 15_000
  const key = `${rbTime}:${appleTime}:${Math.floor(Date.now() / 30_000)}`
  if (!force && cache?.key === key && !analysisDue) return cache.library
  merged = { version: v, at: Date.now() }
  // The rekordbox export is optional: without it Selector runs on music folders alone.
  if (!parsed || parsed.rbTime !== rbTime || parsed.appleTime !== appleTime) {
    parsed = {
      rbTime,
      appleTime,
      rb: rbTime === null ? { tracks: [], playlists: [], raw: new Map<string, RawTrack>() } : parseRekordboxXml(await readFile(paths.rekordbox, 'utf8')),
      apple: appleTime === null ? undefined : parseAppleLibrary(await readFile(paths.apple, 'utf8')),
    }
  }
  // Fresh copies each build: playability and analysis are filled in below.
  const rb = { ...parsed.rb, tracks: parsed.rb.tracks.map((t) => ({ ...t })) }
  const apple = parsed.apple
  // rekordbox's file tracks: playable only if the file is there right now (e.g. an external drive is plugged in).
  for (const t of rb.tracks) {
    if (t.source !== 'file') continue
    const p = locationToPath(t.location)
    if (p && isProtected(p)) Object.assign(t, { playable: false, blocked: 'protected' })
    else if (p && (await exists(p))) t.playable = true
    else t.blocked = 'missing'
  }
  const files = await scanFiles(undefined, force)
  await applyAnalysis([...rb.tracks.filter((t) => t.source === 'file'), ...files], (t) => locationToPath(t.location))
  const library = buildLibrary(rb, apple, files)
  const filePaths = new Map<string, string>()
  for (const t of library.tracks) {
    const p = t.playable ? locationToPath(t.location) : null
    if (p) filePaths.set(t.id, p)
  }
  cache = { key, library, raw: rb.raw, paths: filePaths }
  return cache.library
}

async function exists(p: string) {
  try {
    return (await stat(p)).isFile() // a folder at that path is not a song
  } catch {
    return false
  }
}

/** The file behind a playable track id; only library tracks can ever be served. */
export async function audioPath(id: string): Promise<string | null> {
  await loadLibrary()
  return cache!.paths.get(id) ?? null
}

/** rekordbox's own record of each track, for writing playlists it will recognise. */
export async function rawTracks(): Promise<Map<string, RawTrack>> {
  await loadLibrary()
  return cache!.raw
}
