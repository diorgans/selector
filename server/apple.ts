import { parse as parsePlist } from 'plist'

// Reads the Music app's File › Library › Export Library file. Its songs carry
// no Apple Music catalog ids, so they're matched to rekordbox by artist + title.

export type AppleSong = { pid: string; title: string; artist: string; durationSec: number }
export type ApplePlaylist = { id: string; name: string; songPids: string[] }

type RawTrack = { 'Persistent ID': string; 'Track ID': number; Name?: string; Artist?: string; 'Total Time'?: number }
type RawPlaylist = {
  Name: string
  'Playlist Persistent ID': string
  Master?: boolean
  'Distinguished Kind'?: number
  Folder?: boolean
  'Smart Info'?: unknown
  'Playlist Items'?: { 'Track ID': number }[]
}

export function parseAppleLibrary(xml: string): { songs: AppleSong[]; playlists: ApplePlaylist[] } {
  const doc = parsePlist(xml) as unknown as { Tracks?: Record<string, RawTrack>; Playlists?: RawPlaylist[] }
  if (!doc?.Tracks) throw new Error('Not a Music app library export (no Tracks found).')

  const byTrackId = new Map<number, string>()
  const songs: AppleSong[] = []
  for (const t of Object.values(doc.Tracks)) {
    byTrackId.set(t['Track ID'], t['Persistent ID'])
    songs.push({ pid: t['Persistent ID'], title: t.Name ?? '', artist: t.Artist ?? '', durationSec: Math.round((t['Total Time'] ?? 0) / 1000) })
  }

  // Skip the built-in ones (Library, Music, Recently Played...) and folders.
  const playlists = (doc.Playlists ?? [])
    .filter((p) => !p.Master && p['Distinguished Kind'] === undefined && !p.Folder)
    .map((p) => ({
      id: p['Playlist Persistent ID'],
      name: p.Name,
      songPids: (p['Playlist Items'] ?? []).map((i) => byTrackId.get(i['Track ID'])).filter((x): x is string => !!x),
    }))
  return { songs, playlists }
}
