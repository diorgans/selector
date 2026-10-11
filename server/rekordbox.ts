import { XMLParser } from 'fast-xml-parser'
import { toCamelot } from '../shared/camelot.ts'
import type { Track } from '../shared/types.ts'

// Reads rekordbox's "Export Collection in xml format" file. The format is
// documented at rekordbox.com/en/support/developer.

type Attrs = Record<string, string>
export type RawTrack = Attrs & { TEMPO?: Attrs[]; POSITION_MARK?: Attrs[] }
type RawNode = Attrs & { NODE?: RawNode[]; TRACK?: Attrs[] }

export type RekordboxPlaylist = { path: string[]; trackIds: string[] }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  isArray: (name) => ['TRACK', 'NODE', 'TEMPO', 'POSITION_MARK'].includes(name),
})

// rekordbox stores star ratings as 0, 51, 102, 153, 204, 255.
const stars = (raw: string | undefined) => Math.round(Number(raw ?? 0) / 51)

function source(location: string): Track['source'] | 'skip' {
  if (location.includes('apple-music:')) return 'streaming'
  if (location.includes('/rekordbox/Sampler/')) return 'skip' // rekordbox's built-in sampler sounds
  return 'file'
}

export function parseRekordboxXml(xml: string): { tracks: Track[]; playlists: RekordboxPlaylist[]; raw: Map<string, RawTrack> } {
  const doc = parser.parse(xml)?.DJ_PLAYLISTS
  if (!doc?.COLLECTION) throw new Error('Not a rekordbox collection export (no COLLECTION found).')

  const tracks: Track[] = []
  // Tracks exactly as rekordbox wrote them, so exported playlists hand them back unchanged.
  const raw = new Map<string, RawTrack>()
  for (const t of (doc.COLLECTION.TRACK ?? []) as RawTrack[]) {
    const location = t.Location ?? ''
    const src = source(location)
    if (src === 'skip') continue
    raw.set(t.TrackID, t)
    const bpm = Number(t.AverageBpm)
    tracks.push({
      id: t.TrackID,
      title: t.Name ?? '',
      artist: t.Artist ?? '',
      album: t.Album ?? '',
      genre: t.Genre ?? '',
      bpm: bpm > 0 ? bpm : null,
      key: toCamelot(t.Tonality),
      durationSec: Number(t.TotalTime) || 0,
      source: src,
      location,
      playCount: Number(t.PlayCount) || 0,
      rating: stars(t.Rating),
      dateAdded: t.DateAdded ?? '',
      crates: [],
      playable: false, // decided later, once the file is checked on disk
      firstBeatSec: t.TEMPO?.[0] ? Number(t.TEMPO[0].Inizio) : undefined,
      cues: (t.POSITION_MARK ?? [])
        .filter((m) => m.Type === '0')
        .map((m) => ({ num: Number(m.Num), name: m.Name ?? '', timeSec: Number(m.Start) })),
    })
  }

  const playlists: RekordboxPlaylist[] = []
  const walk = (node: RawNode, path: string[]) => {
    for (const child of node.NODE ?? []) {
      const here = [...path, child.Name]
      if (child.Type === '1') playlists.push({ path: here, trackIds: (child.TRACK ?? []).map((r) => r.Key) })
      else walk(child, here)
    }
  }
  const root = doc.PLAYLISTS?.NODE?.[0]
  if (root) walk(root, [])
  return { tracks, playlists, raw }
}
