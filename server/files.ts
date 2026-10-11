import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toCamelot } from '../shared/camelot.ts'
import type { Track } from '../shared/types.ts'

// Music files Noah owns: found by scanning folders (downloaded iCloud songs land
// in ~/Music/Music/Media.localized), plus the file tracks rekordbox knows.

export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.aif', '.aiff', '.flac', '.m4p'])
const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac',
}

export const musicDirs = (process.env.SELECTOR_MUSIC_DIRS ?? [join(homedir(), 'Music', 'Music', 'Media.localized'), join(homedir(), '.selector', 'demo')].join(':'))
  .split(':')
  .filter(Boolean)

const SCAN_CACHE = process.env.SELECTOR_SCAN_CACHE ?? join(homedir(), '.selector', 'scan-cache.json')

/** rekordbox writes paths as file://localhost/Users/...; turn one into a plain path (or null for streaming). */
export function locationToPath(location: string): string | null {
  if (!location.startsWith('file://localhost/')) return null
  try {
    return fileURLToPath(location.replace('file://localhost/', 'file:///'))
  } catch {
    return null
  }
}

export const fileId = (path: string) => `f${createHash('sha1').update(path).digest('hex').slice(0, 12)}`

/** Apple's copy-protected downloads end in .m4p; they can't be decoded outside Apple's apps. */
export const isProtected = (path: string) => extname(path).toLowerCase() === '.m4p'

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out // folder missing or drive unplugged
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (AUDIO_EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
  return out
}

type Cached = { mtimeMs: number; size: number; track: Track }

/** Scan the music folders; tags are read once per file and cached by size + modified time. */
export async function scanFiles(dirs = musicDirs): Promise<Track[]> {
  let cache: Record<string, Cached> = {}
  try {
    cache = JSON.parse(await readFile(SCAN_CACHE, 'utf8'))
  } catch {
    /* first scan */
  }
  const { parseFile } = await import('music-metadata')
  const paths = (await Promise.all(dirs.map((d) => walk(d)))).flat()
  const next: Record<string, Cached> = {}
  const tracks: Track[] = []
  for (const path of paths) {
    const st = await stat(path)
    const hit = cache[path]
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      next[path] = hit
      tracks.push(hit.track)
      continue
    }
    let meta: Awaited<ReturnType<typeof parseFile>> | undefined
    try {
      meta = await parseFile(path, { duration: true, skipCovers: true })
    } catch {
      /* unreadable tags: fall back to the file name */
    }
    const c = meta?.common
    const fromName = path.split('/').pop()!.replace(/\.[^.]+$/, '')
    const bpm = Number(c?.bpm) || null
    const track: Track = {
      id: fileId(path),
      title: c?.title || fromName,
      artist: c?.artist || '',
      album: c?.album || '',
      genre: c?.genre?.[0] || '',
      bpm: bpm && bpm > 40 ? bpm : null,
      key: toCamelot(c?.key),
      durationSec: Math.round(meta?.format.duration ?? 0),
      source: 'file',
      location: `file://localhost${encodeURI(path)}`,
      playCount: 0,
      rating: 0,
      dateAdded: new Date(st.birthtimeMs).toISOString().slice(0, 10),
      crates: [],
      playable: !isProtected(path),
      blocked: isProtected(path) ? 'protected' : undefined,
    }
    next[path] = { mtimeMs: st.mtimeMs, size: st.size, track }
    tracks.push(track)
  }
  await mkdir(dirname(SCAN_CACHE), { recursive: true })
  await writeFile(`${SCAN_CACHE}.tmp`, JSON.stringify(next))
  await rename(`${SCAN_CACHE}.tmp`, SCAN_CACHE)
  return tracks
}

/** Stream a library file to the browser, with byte ranges so seeking works. */
export async function serveAudio(path: string, req: IncomingMessage, res: ServerResponse) {
  const st = await stat(path)
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2])
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
    res.setHeader('Content-Length', end - start + 1)
    createReadStream(path, { start, end }).pipe(res)
  } else {
    res.setHeader('Content-Length', st.size)
    createReadStream(path).pipe(res)
  }
}
