// The Camelot wheel: DJs' shorthand for musical keys. Numbers 1–12 go round the
// circle of fifths; A is minor, B is major. Neighbours on the wheel mix cleanly.

export type Camelot = { n: number; letter: 'A' | 'B' }

// rekordbox can show keys either as Camelot ("8A") or as music notation ("Am"),
// depending on a preference, so accept both.
const MUSICAL: Record<string, string> = {
  'G#m': '1A', Abm: '1A', B: '1B',
  'D#m': '2A', Ebm: '2A', 'F#': '2B', Gb: '2B',
  'A#m': '3A', Bbm: '3A', 'C#': '3B', Db: '3B',
  Fm: '4A', 'G#': '4B', Ab: '4B',
  Cm: '5A', 'D#': '5B', Eb: '5B',
  Gm: '6A', 'A#': '6B', Bb: '6B',
  Dm: '7A', F: '7B',
  Am: '8A', C: '8B',
  Em: '9A', G: '9B',
  Bm: '10A', D: '10B',
  'F#m': '11A', Gbm: '11A', A: '11B',
  'C#m': '12A', Dbm: '12A', E: '12B',
}

/** Normalise any rekordbox key string to Camelot ("8A"), or null if unknown. */
export function toCamelot(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const m = s.match(/^(\d{1,2})([AB])$/i)
  if (m) {
    const n = Number(m[1])
    return n >= 1 && n <= 12 ? `${n}${m[2].toUpperCase()}` : null
  }
  return MUSICAL[s] ?? null
}

export function parseCamelot(code: string): Camelot {
  return { n: Number(code.slice(0, -1)), letter: code.slice(-1) as 'A' | 'B' }
}

/** Hue for a key, so the same key is always the same colour around the wheel. */
export function camelotHue(code: string): number {
  return ((parseCamelot(code).n - 1) * 30 + 200) % 360
}

const wrap = (n: number) => ((n - 1 + 12) % 12) + 1

/** Keys that mix cleanly from `code`: the same key, one step either way, or its relative major/minor. */
export function harmonicNeighbors(code: string): string[] {
  const { n, letter } = parseCamelot(code)
  const other = letter === 'A' ? 'B' : 'A'
  return [`${n}${letter}`, `${wrap(n - 1)}${letter}`, `${wrap(n + 1)}${letter}`, `${n}${other}`]
}

/** True when `b` can be beatmatched to `a` within `tolerance` (6% ≈ a pitch fader's range), counting half and double time. */
export function bpmCompatible(a: number | null, b: number | null, tolerance = 0.06): boolean {
  if (!a || !b) return false
  return [b, b * 2, b / 2].some((x) => Math.abs(x / a - 1) <= tolerance)
}

/** Keys work together and the tempos can be matched. */
export function mixesWell(a: { key: string | null; bpm: number | null }, b: { key: string | null; bpm: number | null }): boolean {
  return !!a.key && !!b.key && harmonicNeighbors(a.key).includes(b.key) && bpmCompatible(a.bpm, b.bpm)
}
