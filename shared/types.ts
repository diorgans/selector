// The library as the app sees it, built from Noah's rekordbox and Apple Music
// exports. Nothing here is ever written back to rekordbox's own files.

export type TrackSource = 'streaming' | 'file'

export type Cue = { num: number; name: string; timeSec: number } // num 0–7 = hot cue A–H, -1 = memory cue

export type Track = {
  id: string // rekordbox TrackID
  title: string
  artist: string
  album: string
  genre: string
  bpm: number | null
  key: string | null // Camelot, e.g. "8A"
  durationSec: number
  source: TrackSource
  location: string // as rekordbox wrote it; written back unchanged in exported playlists
  playCount: number
  rating: number // 0–5 stars
  dateAdded: string
  crates: string[] // crate ids this track belongs to
  // Player fields (owned files only)
  playable: boolean // a file Selector can open right now (exists, not copy-protected)
  blocked?: 'missing' | 'protected' // why a file isn't playable: drive unplugged, or Apple copy protection
  firstBeatSec?: number // where the beatgrid starts
  cues?: Cue[]
}

export type Crate = {
  id: string
  name: string
  origin: 'apple' | 'rekordbox'
  trackIds: string[] // only tracks rekordbox knows (and so can play)
  totalItems: number // everything in the original playlist, including songs not in rekordbox yet
}

export type Library = {
  tracks: Track[]
  crates: Crate[]
  stats: { tracks: number; analyzed: number; streaming: number; files: number; playable: number; appleMatched: number }
  importedAt: string
}
