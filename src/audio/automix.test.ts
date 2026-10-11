import { describe, expect, it } from 'vitest'
import type { Track } from '../../shared/types.ts'
import { pickNext, planTransition, type AutomixSettings } from './automix.ts'

const out = (o: Partial<Parameters<typeof planTransition>[0]> = {}) => ({ bpm: 124, firstBeat: 0.5, duration: 300, rate: 1, position: 10, ...o })

describe('planTransition', () => {
  it('starts on a phrase (multiple of 32 beats) and finishes before the track ends', () => {
    const p = planTransition(out(), { bpm: 126, firstBeat: 0.2 }, 64)
    const beat = 60 / 124
    const startBeat = (p.outStart - 0.5) / beat
    expect(startBeat % 32).toBeCloseTo(0, 6)
    expect(p.outStart + p.duration * 1).toBeLessThan(300 - 4 * beat)
    expect(p.duration).toBeCloseTo(64 * beat, 6) // 16 bars = 64 beats
    expect(p.inStart).toBe(0.2)
  })
  it('matches tempo, allowing half/double time', () => {
    expect(planTransition(out(), { bpm: 126, firstBeat: 0 }, 64).inRate).toBeCloseTo(124 / 126, 6)
    expect(planTransition(out({ rate: 1.02 }), { bpm: 124, firstBeat: 0 }, 64).inRate).toBeCloseTo(1.02, 6)
    expect(planTransition(out(), { bpm: 62, firstBeat: 0 }, 64).inRate).toBeCloseTo(1, 6)
    const far = planTransition(out(), { bpm: 90, firstBeat: 0 }, 64)
    expect(far.synced).toBe(false)
    expect(far.inRate).toBe(1)
  })
  it('uses the next bar when the phrase has already passed', () => {
    const p = planTransition(out({ duration: 60, position: 50 }), { bpm: 124, firstBeat: 0 }, 64)
    const beat = 60 / 124
    const startBeat = (p.outStart - 0.5) / beat
    expect(startBeat % 4).toBeCloseTo(0, 6)
    expect(p.outStart).toBeGreaterThan(50)
  })
  it('falls back to a timed fade without a beatgrid; window length follows the beats asked for', () => {
    expect(planTransition(out({ bpm: null }), { bpm: null, firstBeat: 0 }, 64)).toMatchObject({ synced: false, duration: 8 })
    expect(planTransition(out(), { bpm: 124, firstBeat: 0 }, 4).duration).toBeCloseTo((4 * 60) / 124, 6)
  })
})

const t = (id: string, key: string, bpm: number, extra: Partial<Track> = {}): Track => ({
  id, title: id, artist: '', album: '', genre: '', bpm, key, durationSec: 200, source: 'file', location: '',
  playCount: 0, rating: 0, dateAdded: '', crates: [], playable: true, ...extra,
})

describe('pickNext', () => {
  const now = t('now', '8A', 124)
  const pool = [now, t('a', '9A', 126), t('b', '8A', 124), t('locked', '8A', 124, { playable: false }), t('c', '3B', 124)]
  const smart: AutomixSettings = { source: 'smart', direction: 'lift', style: 'blend', bars: 16, useStems: false }
  it('smart: best mixable suggestion, never played or unplayable tracks', () => {
    expect(pickNext(now, pool, new Set(), smart, [])?.id).toBe('a')
    expect(pickNext(now, pool, new Set(['a']), smart, [])?.id).toBe('b')
  })
  it('set: follows the set order after the current track, skipping what it cannot play', () => {
    expect(pickNext(now, pool, new Set(), { ...smart, source: 'set' }, ['x', 'now', 'locked', 'c', 'a'])?.id).toBe('c')
  })
})
