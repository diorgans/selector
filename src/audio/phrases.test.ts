import { describe, expect, it } from 'vitest'
import { labelPhrases, whereAmI, type Phrase } from './phrases.ts'

describe('labelPhrases', () => {
  it('names a classic club structure', () => {
    //                 intro intro build drop drop breakdown build drop outro outro
    const energy = [0.35, 0.4, 0.62, 1, 0.95, 0.38, 0.6, 1, 0.45, 0.3]
    expect(labelPhrases(energy)).toEqual(['Intro', 'Intro', 'Build', 'Drop', 'Drop', 'Breakdown', 'Build', 'Drop', 'Outro', 'Outro'])
  })
  it('handles flat songs without a drop', () => {
    expect(labelPhrases([0.5, 0.6, 0.6, 0.55])).toEqual(['Intro', 'Verse', 'Verse', 'Outro'])
  })
  it('handles empty input', () => {
    expect(labelPhrases([])).toEqual([])
  })
})

describe('whereAmI', () => {
  const bpm = 120 // 0.5 s per beat, 2 s per bar, 16 s per 8-bar phrase
  const phrases: Phrase[] = [
    { kind: 'Intro', start: 0.25, end: 16.25, energy: 0.4 },
    { kind: 'Drop', start: 16.25, end: 32.25, energy: 1 },
  ]
  it('counts bars and beats from the first beat', () => {
    expect(whereAmI(0.25, 0.25, bpm, phrases)).toMatchObject({ bar: 1, beat: 1 })
    expect(whereAmI(1.3, 0.25, bpm, phrases)).toMatchObject({ bar: 1, beat: 3 })
    expect(whereAmI(2.3, 0.25, bpm, phrases)).toMatchObject({ bar: 2, beat: 1 })
  })
  it('knows the phrase and the bars left in it', () => {
    const w = whereAmI(12.25, 0.25, bpm, phrases)
    expect(w.phrase?.kind).toBe('Intro')
    expect(w.barsLeft).toBeCloseTo(2, 6)
    expect(whereAmI(20, 0.25, bpm, phrases).phrase?.kind).toBe('Drop')
  })
})
