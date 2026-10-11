import type { Track } from '../shared/types.ts'

// "My Library": the music files Noah owns, grouped by where they live.
export type Group = { id: string; name: string; hint: string; trackIds: string[] }

export function libraryGroups(tracks: Track[]): Group[] {
  const files = tracks.filter((t) => t.source === 'file')
  const where = (t: Track) => decodeURI(t.location)
  const make = (id: string, name: string, hint: string, pick: (t: Track) => boolean): Group => ({ id: `lib:${id}`, name, hint, trackIds: files.filter(pick).map((t) => t.id) })

  const groups = [
    make('all', 'All my music', 'Every music file Selector knows about', () => true),
    make('ready', 'Ready to play', 'Files Selector can load onto a deck right now', (t) => t.playable),
    make('downloaded', 'Downloaded from Music', 'Songs downloaded in the Music app (~/Music/Music)', (t) => where(t).includes('/Music/Music/Media')),
  ]
  // One group per external drive, e.g. "Trojan drive".
  const drives = [...new Set(files.map((t) => where(t).match(/\/Volumes\/([^/]+)\//)?.[1]).filter((d): d is string => !!d))]
  for (const d of drives.sort())
    groups.push(make(`drive:${d}`, `${d} drive`, `Files on the ${d} drive; greyed out while it's unplugged`, (t) => where(t).includes(`/Volumes/${d}/`)))
  groups.push(
    make('rekordbox', 'From rekordbox', 'Music files in your rekordbox collection', (t) => !t.id.startsWith('f')),
    make('demo', 'Demo loops', 'Test loops Selector generated', (t) => where(t).includes('/.selector/demo/')),
  )
  return groups
}
