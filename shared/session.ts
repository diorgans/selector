import { mixesWell } from './camelot.ts'

// A DJ session: what was actually audible, in order. Used for the set recap.

export type SessionTrack = {
  trackId: string
  title: string
  artist: string
  bpm: number | null // the tempo it was played at
  key: string | null
  startedAt: number // epoch ms when it went on air
  playedSec: number
  via: 'manual' | 'automix'
}

export type Session = { id: string; name: string; startedAt: number; endedAt: number; tracks: SessionTrack[] }

export function sessionStats(s: Session) {
  const t = s.tracks
  const bpms = t.map((x) => x.bpm).filter((b): b is number => !!b)
  const steps = t.slice(1).map((x, i) => ({ from: t[i], to: x }))
  const scored = steps.filter((st) => st.from.key && st.to.key && st.from.bpm && st.to.bpm)
  const clean = scored.filter((st) => mixesWell(st.from, st.to)).length
  return {
    minutes: Math.max(0, Math.round((s.endedAt - s.startedAt) / 60000)),
    tracks: t.length,
    bpmMin: bpms.length ? Math.round(Math.min(...bpms)) : null,
    bpmMax: bpms.length ? Math.round(Math.max(...bpms)) : null,
    bpmAvg: bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : null,
    harmonicPct: scored.length ? Math.round((clean / scored.length) * 100) : null,
    transitions: steps.length,
    automixed: t.filter((x) => x.via === 'automix').length,
    keyPath: t.map((x) => x.key).filter((k): k is string => !!k),
    // Energy curve: BPM against minutes into the set.
    curve: t.filter((x) => x.bpm).map((x) => ({ min: (x.startedAt - s.startedAt) / 60000, bpm: x.bpm! })),
  }
}

const stamp = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** "00:00 Artist – Title" lines, ready for a SoundCloud or Mixcloud description. */
export function tracklistText(s: Session): string {
  return s.tracks.map((t) => `${stamp(t.startedAt - s.startedAt)} ${t.artist ? `${t.artist} – ` : ''}${t.title}`).join('\n')
}

export function defaultSessionName(startedAt: number): string {
  const d = new Date(startedAt)
  const part = d.getHours() < 5 ? 'Late-night' : d.getHours() < 12 ? 'Morning' : d.getHours() < 17 ? 'Afternoon' : 'Evening'
  return `${part} set · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}
