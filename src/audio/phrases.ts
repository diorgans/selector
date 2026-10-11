// Phrase detection: dance music is built in 8-bar phrases. We measure the energy of
// each bar along the beatgrid, average it per phrase, and name each phrase from its
// energy and where it sits in the song (Intro, Verse, Build, Drop, Breakdown, Outro).

import type { Waveform } from './waveform.ts'

export type PhraseKind = 'Intro' | 'Verse' | 'Build' | 'Drop' | 'Breakdown' | 'Outro'
export type Phrase = { kind: PhraseKind; start: number; end: number; energy: number } // seconds; energy 0..1

export const PHRASE_BARS = 8

/** Energy of each bar (0..1 relative to the loudest bar), from the waveform's band levels. */
export function barEnergies(wf: Waveform, firstBeat: number, bpm: number, duration: number): number[] {
  const bar = (60 / bpm) * 4
  const out: number[] = []
  for (let t = firstBeat; t + bar <= duration + 0.01; t += bar) {
    const a = Math.floor(t * wf.binsPerSecond), b = Math.min(wf.low.length, Math.floor((t + bar) * wf.binsPerSecond))
    let sum = 0
    for (let i = a; i < b; i++) sum += wf.low[i] * 1.2 + wf.mid[i] + wf.high[i] * 0.6 // kick and bass weigh most
    out.push(b > a ? sum / (b - a) : 0)
  }
  const max = Math.max(1e-6, ...out)
  return out.map((v) => v / max)
}

/** Name each 8-bar phrase from its energy and position. */
export function labelPhrases(energies: number[]): PhraseKind[] {
  const n = energies.length
  if (!n) return []
  const high = 0.72, low = 0.5
  const firstHigh = energies.findIndex((e) => e >= high)
  const lastHigh = n - 1 - [...energies].reverse().findIndex((e) => e >= high)
  return energies.map((e, i) => {
    if (firstHigh === -1) return i === 0 ? 'Intro' : i === n - 1 && n > 2 ? 'Outro' : 'Verse'
    if (i < firstHigh) {
      // Just before the first drop and clearly rising: the build.
      if (i === firstHigh - 1 && i > 0 && e > energies[i - 1] + 0.08) return 'Build'
      return 'Intro'
    }
    if (i > lastHigh) return 'Outro'
    if (e >= high) return 'Drop'
    if (e < low) return 'Breakdown'
    // A mid-energy phrase that leads straight into a drop and rises into it.
    if (energies[i + 1] >= high && e > (energies[i - 1] ?? 0) + 0.05) return 'Build'
    return 'Verse'
  })
}

export function detectPhrases(wf: Waveform, firstBeat: number, bpm: number | null, duration: number): Phrase[] {
  if (!bpm) return []
  const bars = barEnergies(wf, firstBeat, bpm, duration)
  const phraseLen = (60 / bpm) * 4 * PHRASE_BARS
  const energies: number[] = []
  for (let i = 0; i < bars.length; i += PHRASE_BARS) {
    const chunk = bars.slice(i, i + PHRASE_BARS)
    energies.push(chunk.reduce((a, b) => a + b, 0) / chunk.length)
  }
  // Re-normalise per phrase so labels compare phrases, not single loud bars.
  const max = Math.max(1e-6, ...energies)
  const norm = energies.map((e) => e / max)
  return labelPhrases(norm).map((kind, i) => ({
    kind,
    start: firstBeat + i * phraseLen,
    end: Math.min(duration, firstBeat + (i + 1) * phraseLen),
    energy: norm[i],
  }))
}

/** Where the playhead is: bar and beat (1-based), the phrase, and bars left in it. */
export function whereAmI(pos: number, firstBeat: number, bpm: number, phrases: Phrase[]) {
  const beat = 60 / bpm
  const beats = Math.floor((pos - firstBeat) / beat)
  const phrase = phrases.find((p) => pos >= p.start && pos < p.end)
  const barsLeft = phrase ? (phrase.end - pos) / (beat * 4) : null
  return { bar: Math.floor(beats / 4) + 1, beat: (((beats % 4) + 4) % 4) + 1, phrase, barsLeft }
}

export const PHRASE_COLORS: Record<PhraseKind, string> = {
  Intro: '#60a5fa',
  Verse: '#a78bfa',
  Build: '#fbbf24',
  Drop: '#f43f5e',
  Breakdown: '#34d399',
  Outro: '#94a3b8',
}
