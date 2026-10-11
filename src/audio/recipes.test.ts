import { describe, expect, it } from 'vitest'
import { pickRecipe, RECIPES, type StyleId } from './recipes.ts'

describe('recipes', () => {
  for (const r of Object.values(RECIPES)) {
    it(`${r.name}: moves stay inside the window and never overlap on one control`, () => {
      for (const m of r.moves) {
        expect(m.at).toBeGreaterThanOrEqual(0)
        expect(m.at + m.dur).toBeLessThanOrEqual(1)
      }
      const byControl = new Map<string, typeof r.moves>()
      for (const m of r.moves) byControl.set(`${m.deck}:${m.ctl}`, [...(byControl.get(`${m.deck}:${m.ctl}`) ?? []), m])
      for (const moves of byControl.values()) {
        const sorted = [...moves].sort((a, b) => a.at - b.at)
        for (let i = 1; i < sorted.length; i++) expect(sorted[i].at).toBeGreaterThanOrEqual(sorted[i - 1].at + sorted[i - 1].dur)
      }
      // Crossfader starts on the old track and ends fully on the new one.
      expect(r.xfade[0]).toEqual({ at: 0, x: 0 })
      expect(r.xfade.at(-1)!.x).toBe(1)
    })
  }
  it('both tracks are heard together in the layering styles', () => {
    for (const id of ['layer', 'eqswap', 'filterswap', 'stems'] as StyleId[]) {
      const held = RECIPES[id].xfade.filter((p) => p.x === 0.5)
      expect(held.at(-1)!.at - held[0].at).toBeGreaterThan(0.5)
    }
  })
  it('the bass never doubles up: incoming bass is killed until the swap', () => {
    for (const r of Object.values(RECIPES).filter((x) => x.id !== 'cut')) {
      const first = r.moves.filter((m) => m.deck === 'in' && m.ctl === 'low').sort((a, b) => a.at - b.at)[0]
      expect(first).toMatchObject({ at: 0, to: 0 })
    }
  })
})

describe('pickRecipe', () => {
  it('never repeats the last style and skips stems without them', () => {
    for (let i = 0; i < 200; i++) {
      const r = pickRecipe('lift', false, 'filterswap')
      expect(r.id).not.toBe('filterswap')
      expect(r.id).not.toBe('stems')
    }
  })
  it('suits the energy: cooling down never cuts', () => {
    const seen = new Set(Array.from({ length: 300 }, () => pickRecipe('cool', true).id))
    expect(seen.has('cut')).toBe(false)
    expect(seen.has('layer')).toBe(true)
  })
  it('is weighted, deterministic for a given random number', () => {
    expect(pickRecipe('hold', true, undefined, () => 0).id).toBe('layer')
  })
})
