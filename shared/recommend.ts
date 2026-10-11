import { parseCamelot } from './camelot.ts'
import type { Track } from './types.ts'

// Next-track suggestions, scored on-device with reasons a DJ can check.
// No audio analysis is possible for streaming tracks, so "vibe" comes from
// genre and from Noah's own playlists (songs he grouped together go together).

export type Direction = 'lift' | 'hold' | 'cool'
export type Reason = { label: string; tone: 'good' | 'ok' | 'warn' }
export type Suggestion = { track: Track; score: number; reasons: Reason[]; parts: Record<'key' | 'tempo' | 'direction' | 'vibe', number> }

// Direction outweighs vibe: when Noah asks to cool down, a same-genre track that lifts should not win.
const WEIGHTS = { key: 35, tempo: 25, direction: 25, vibe: 15 }

/** How a key move sounds, in Camelot steps. */
export function keyMove(from: string, to: string): { score: number; label: string; steps: number } | null {
  const a = parseCamelot(from), b = parseCamelot(to)
  const steps = ((b.n - a.n + 18) % 12) - 6 // -6..5, signed distance round the wheel
  if (a.letter === b.letter) {
    if (steps === 0) return { score: 1, label: `${from} → ${to} · same key`, steps }
    if (steps === 1) return { score: 0.9, label: `${from} → ${to} · +1 lift`, steps }
    if (steps === -1) return { score: 0.9, label: `${from} → ${to} · −1 softer`, steps }
    if (steps === 2) return { score: 0.6, label: `${from} → ${to} · +2 energy boost`, steps }
    return null
  }
  if (steps === 0) return { score: 0.85, label: `${from} → ${to} · ${b.letter === 'B' ? 'brighter (major)' : 'darker (minor)'}`, steps }
  return null
}

/** Tempo change after allowing half/double time; null if no version is within 8%. */
export function tempoMove(from: number, to: number): { pct: number; label: string } | null {
  const options = [
    { bpm: to, note: '' },
    { bpm: to * 2, note: ' (half-time)' },
    { bpm: to / 2, note: ' (double-time)' },
  ].map((o) => ({ ...o, pct: o.bpm / from - 1 }))
  const best = options.reduce((x, y) => (Math.abs(y.pct) < Math.abs(x.pct) ? y : x))
  if (Math.abs(best.pct) > 0.08) return null
  const diff = Math.round(best.bpm - from)
  const label = diff === 0 ? `${Math.round(to)} BPM · same tempo${best.note}` : `${Math.round(to)} BPM · ${diff > 0 ? '+' : ''}${diff}${best.note}`
  return { pct: best.pct, label }
}

const genreKey = (g: string) => g.toLowerCase().replace(/[^a-z]/g, '')

export function suggestNext(
  current: Track,
  pool: Track[],
  opts: { direction: Direction; exclude?: Set<string>; crateNames?: Map<string, string>; limit?: number },
): Suggestion[] {
  if (!current.key || !current.bpm) return []
  const out: Suggestion[] = []
  for (const t of pool) {
    if (t.id === current.id || opts.exclude?.has(t.id) || !t.key || !t.bpm) continue
    const key = keyMove(current.key, t.key)
    const tempo = tempoMove(current.bpm, t.bpm)
    if (!key || !tempo) continue // not mixable: skip rather than rank low

    const reasons: Reason[] = [
      { label: key.label, tone: key.score >= 0.85 ? 'good' : 'ok' },
      { label: tempo.label, tone: Math.abs(tempo.pct) <= 0.03 ? 'good' : 'ok' },
    ]
    const tempoScore = 1 - Math.abs(tempo.pct) / 0.08

    // Direction: does this move the energy the way Noah asked?
    const up = tempo.pct > 0.005 || key.steps > 0
    const down = tempo.pct < -0.005 || key.steps < 0
    const direction = opts.direction === 'lift' ? (up && !down ? 1 : up ? 0.6 : down ? 0 : 0.4)
      : opts.direction === 'cool' ? (down && !up ? 1 : down ? 0.6 : up ? 0 : 0.4)
      : Math.abs(tempo.pct) <= 0.02 && Math.abs(key.steps) <= 1 ? 1 : 0.4
    if (opts.direction !== 'hold' && direction === 1) reasons.push({ label: opts.direction === 'lift' ? 'lifts energy' : 'brings it down', tone: 'good' })

    // Vibe: same genre, and how many of Noah's playlists both songs share.
    const sameGenre = !!current.genre && genreKey(current.genre) === genreKey(t.genre)
    const shared = t.crates.filter((c) => current.crates.includes(c))
    const vibe = Math.min(1, (sameGenre ? 0.5 : 0) + Math.min(shared.length, 2) * 0.25)
    if (sameGenre) reasons.push({ label: t.genre, tone: 'good' })
    if (shared.length) reasons.push({ label: `also in ${opts.crateNames?.get(shared[0]) ?? 'your playlist'}${shared.length > 1 ? ` +${shared.length - 1}` : ''}`, tone: 'good' })

    const parts = { key: key.score, tempo: tempoScore, direction, vibe }
    const score = Math.round(
      parts.key * WEIGHTS.key + parts.tempo * WEIGHTS.tempo + parts.direction * WEIGHTS.direction + parts.vibe * WEIGHTS.vibe,
    )
    out.push({ track: t, score, reasons, parts })
  }
  return out.sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title)).slice(0, opts.limit ?? 10)
}
