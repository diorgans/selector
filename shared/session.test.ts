import { describe, expect, it } from 'vitest'
import { sessionStats, tracklistText, type Session, type SessionTrack } from './session.ts'

const T0 = Date.UTC(2026, 9, 10, 21, 0, 0)
const tr = (min: number, title: string, artist: string, bpm: number | null, key: string | null, via: SessionTrack['via'] = 'manual'): SessionTrack =>
  ({ trackId: title, title, artist, bpm, key, startedAt: T0 + min * 60000, playedSec: 180, via })

const session: Session = {
  id: 's1', name: 'Test', startedAt: T0, endedAt: T0 + 65 * 60000,
  tracks: [tr(0, 'Night Drive', 'Selector Demo', 124, '8A'), tr(3.5, 'Lift Off', 'Selector Demo', 126, '9A', 'automix'), tr(62, 'Clash', '', 124, '3B'), tr(64, 'Unknown', 'X', null, null)],
}

describe('sessionStats', () => {
  it('summarises length, tempo and key flow', () => {
    const s = sessionStats(session)
    expect(s).toMatchObject({ minutes: 65, tracks: 4, bpmMin: 124, bpmMax: 126, bpmAvg: 125, transitions: 3, automixed: 1 })
    expect(s.keyPath).toEqual(['8A', '9A', '3B'])
    // 8A→9A mixes, 9A→3B clashes; the step into an unanalysed track isn't counted.
    expect(s.harmonicPct).toBe(50)
    expect(s.curve.map((c) => c.bpm)).toEqual([124, 126, 124])
  })
})

describe('tracklistText', () => {
  it('timestamps from the start of the set, with hours once past an hour', () => {
    expect(tracklistText(session).split('\n')).toEqual([
      '00:00 Selector Demo – Night Drive',
      '03:30 Selector Demo – Lift Off',
      '1:02:00 Clash',
      '1:04:00 X – Unknown',
    ])
  })
})
