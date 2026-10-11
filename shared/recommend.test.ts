import { describe, expect, it } from 'vitest'
import { keyMove, suggestNext, tempoMove } from './recommend.ts'
import type { Track } from './types.ts'

const track = (id: string, key: string | null, bpm: number | null, extra: Partial<Track> = {}): Track => ({
  id, title: `T${id}`, artist: 'A', album: '', genre: '', bpm, key, durationSec: 200, source: 'streaming',
  location: '', playCount: 0, rating: 0, dateAdded: '', crates: [], ...extra,
})

describe('keyMove', () => {
  it('names each Camelot move', () => {
    expect(keyMove('8A', '8A')?.score).toBe(1)
    expect(keyMove('8A', '9A')?.label).toContain('+1 lift')
    expect(keyMove('12A', '1A')?.steps).toBe(1) // wraps round the wheel
    expect(keyMove('8A', '7A')?.label).toContain('−1')
    expect(keyMove('8A', '10A')?.label).toContain('energy boost')
    expect(keyMove('8A', '8B')?.label).toContain('major')
    expect(keyMove('8A', '3B')).toBeNull()
  })
})

describe('tempoMove', () => {
  it('handles small changes and half/double time', () => {
    expect(tempoMove(124, 126)?.label).toBe('126 BPM · +2')
    expect(tempoMove(140, 70)?.label).toContain('half-time')
    expect(tempoMove(124, 140)).toBeNull()
  })
})

describe('suggestNext', () => {
  const now = track('0', '8A', 124, { genre: 'House', crates: ['c1'] })
  const pool = [
    now,
    track('same', '8A', 124),
    track('lift', '9A', 126, { genre: 'House', crates: ['c1'] }),
    track('down', '7A', 120),
    track('clash', '3B', 124),
    track('fast', '8A', 150),
    track('unanalyzed', null, null),
  ]
  it('only returns mixable tracks, never the current one', () => {
    const ids = suggestNext(now, pool, { direction: 'hold' }).map((s) => s.track.id)
    expect(ids).not.toContain('0')
    expect(ids).not.toContain('clash')
    expect(ids).not.toContain('fast')
    expect(ids).not.toContain('unanalyzed')
  })
  it('ranks by the chosen direction and explains why', () => {
    const lift = suggestNext(now, pool, { direction: 'lift', crateNames: new Map([['c1', 'House Grooves']]) })
    expect(lift[0].track.id).toBe('lift')
    expect(lift[0].reasons.map((r) => r.label)).toEqual(expect.arrayContaining(['lifts energy', 'House', 'also in House Grooves']))
    const cool = suggestNext(now, pool, { direction: 'cool' })
    expect(cool.findIndex((s) => s.track.id === 'down')).toBeLessThan(cool.findIndex((s) => s.track.id === 'lift'))
  })
  it('skips tracks already in the set', () => {
    expect(suggestNext(now, pool, { direction: 'lift', exclude: new Set(['lift']) }).map((s) => s.track.id)).not.toContain('lift')
  })
})
