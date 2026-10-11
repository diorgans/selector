import type { Track } from '../shared/types.ts'

// Hand-corrected beatgrids: where beat 1 starts for a song, saved in this browser.
const KEY = 'selector-grid'

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function saveGrid(trackId: string, firstBeatSec: number) {
  const all = read()
  all[trackId] = Math.round(firstBeatSec * 10000) / 10000
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* this visit only */
  }
}

/** Apply saved corrections to freshly loaded tracks (in place). */
export function applyGrids(tracks: Track[]) {
  const all = read()
  for (const t of tracks) if (all[t.id] !== undefined) t.firstBeatSec = all[t.id]
  return tracks
}
