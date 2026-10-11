// Transition recipes: timed moves on both decks at once. Times are fractions of
// the transition window (0 = the incoming track starts, 1 = it has fully taken
// over). Crossfader x: 0 = all outgoing, 1 = all incoming. EQ knobs: 0 = kill,
// 0.5 = flat. Filter: -1 = muffled (low-pass), 0 = open, +1 = thin (high-pass).

import type { Direction } from '../../shared/recommend.ts'

export type StyleId = 'blend' | 'layer' | 'eqswap' | 'filterswap' | 'echo' | 'stems' | 'cut'
export type Control = 'low' | 'mid' | 'high' | 'filter' | 'dry' | 'echo' | 'stem:vocals' | 'stem:instruments' | 'stem:drums'
export type Move = { deck: 'out' | 'in'; ctl: Control; from: number; to: number; at: number; dur: number }
export type Recipe = {
  id: StyleId
  name: string
  blurb: string
  beats: (bars: number) => number // window length
  needsStems?: boolean
  xfade: { at: number; x: number }[]
  moves: Move[]
}

/** The incoming bass waits, then both basses trade places at once at `at`. */
const bassSwap = (at: number): Move[] => [
  { deck: 'in', ctl: 'low', from: 0, to: 0, at: 0, dur: 0 },
  { deck: 'out', ctl: 'low', from: 0.5, to: 0, at, dur: 0.02 },
  { deck: 'in', ctl: 'low', from: 0, to: 0.5, at, dur: 0.02 },
]

export const RECIPES: Record<StyleId, Recipe> = {
  blend: {
    id: 'blend', name: 'Blend + bass swap', blurb: 'Smooth crossfade; the basslines trade places halfway.',
    beats: (bars) => bars * 4,
    xfade: [{ at: 0, x: 0 }, { at: 1, x: 1 }],
    moves: bassSwap(0.5),
  },
  layer: {
    id: 'layer', name: 'Long layer', blurb: 'Both tracks play together for most of the mix, carved with EQ.',
    beats: (bars) => Math.max(16, bars) * 4,
    xfade: [{ at: 0, x: 0 }, { at: 0.12, x: 0.5 }, { at: 0.85, x: 0.5 }, { at: 1, x: 1 }],
    moves: [
      ...bassSwap(0.5),
      { deck: 'in', ctl: 'high', from: 0.25, to: 0.25, at: 0, dur: 0 },
      { deck: 'in', ctl: 'high', from: 0.25, to: 0.5, at: 0.12, dur: 0.3 },
      { deck: 'out', ctl: 'high', from: 0.5, to: 0.2, at: 0.55, dur: 0.3 },
      { deck: 'out', ctl: 'mid', from: 0.5, to: 0.25, at: 0.6, dur: 0.25 },
    ],
  },
  eqswap: {
    id: 'eqswap', name: 'Three-band swap', blurb: 'Hats, then mids, then bass trade over one at a time.',
    beats: (bars) => bars * 4,
    xfade: [{ at: 0, x: 0 }, { at: 0.1, x: 0.5 }, { at: 0.9, x: 0.5 }, { at: 1, x: 1 }],
    moves: [
      ...bassSwap(0.7),
      { deck: 'in', ctl: 'mid', from: 0, to: 0, at: 0, dur: 0 },
      { deck: 'in', ctl: 'high', from: 0, to: 0, at: 0, dur: 0 },
      { deck: 'in', ctl: 'high', from: 0, to: 0.5, at: 0.1, dur: 0.15 },
      { deck: 'out', ctl: 'high', from: 0.5, to: 0.05, at: 0.15, dur: 0.15 },
      { deck: 'in', ctl: 'mid', from: 0, to: 0.5, at: 0.4, dur: 0.15 },
      { deck: 'out', ctl: 'mid', from: 0.5, to: 0.05, at: 0.45, dur: 0.15 },
    ],
  },
  filterswap: {
    id: 'filterswap', name: 'Filter swap', blurb: 'The new track opens up as the old one thins out, both at once.',
    beats: (bars) => bars * 4,
    xfade: [{ at: 0, x: 0 }, { at: 0.2, x: 0.5 }, { at: 0.8, x: 0.5 }, { at: 1, x: 1 }],
    moves: [
      ...bassSwap(0.5),
      { deck: 'in', ctl: 'filter', from: -0.85, to: 0, at: 0, dur: 0.6 },
      { deck: 'out', ctl: 'filter', from: 0, to: 0.85, at: 0.35, dur: 0.65 },
    ],
  },
  echo: {
    id: 'echo', name: 'Echo out', blurb: 'The old track echoes away on the beat as the new one lands.',
    beats: () => 16,
    xfade: [{ at: 0, x: 0 }, { at: 0.5, x: 0.5 }, { at: 0.75, x: 0.5 }, { at: 0.76, x: 1 }, { at: 1, x: 1 }],
    moves: [
      { deck: 'in', ctl: 'low', from: 0, to: 0, at: 0, dur: 0 },
      { deck: 'out', ctl: 'echo', from: 0, to: 1, at: 0.55, dur: 0.15 },
      { deck: 'out', ctl: 'dry', from: 1, to: 0, at: 0.75, dur: 0.01 },
      { deck: 'in', ctl: 'low', from: 0, to: 0.5, at: 0.75, dur: 0.01 },
      { deck: 'out', ctl: 'echo', from: 1, to: 0, at: 0.76, dur: 0.01 }, // stop feeding; the tail rings out
    ],
  },
  stems: {
    id: 'stems', name: 'Stem mashup', blurb: 'Drums swap first, then the old vocals ride over the new instrumental.',
    beats: (bars) => Math.max(16, bars) * 4,
    needsStems: true,
    xfade: [{ at: 0, x: 0 }, { at: 0.15, x: 0.5 }, { at: 0.9, x: 0.5 }, { at: 1, x: 1 }],
    moves: [
      ...bassSwap(0.45),
      { deck: 'in', ctl: 'stem:vocals', from: 0, to: 0, at: 0, dur: 0 },
      { deck: 'in', ctl: 'stem:drums', from: 0, to: 0, at: 0, dur: 0 },
      { deck: 'out', ctl: 'stem:drums', from: 1, to: 0, at: 0.15, dur: 0.15 },
      { deck: 'in', ctl: 'stem:drums', from: 0, to: 1, at: 0.2, dur: 0.1 },
      { deck: 'out', ctl: 'stem:instruments', from: 1, to: 0, at: 0.45, dur: 0.15 },
      { deck: 'out', ctl: 'stem:vocals', from: 1, to: 0, at: 0.8, dur: 0.1 },
      { deck: 'in', ctl: 'stem:vocals', from: 0, to: 1, at: 0.82, dur: 0.12 },
    ],
  },
  cut: {
    id: 'cut', name: 'Cut on the bar', blurb: 'An instant switch, right on the downbeat.',
    beats: () => 4,
    xfade: [{ at: 0, x: 0 }, { at: 0.01, x: 1 }, { at: 1, x: 1 }],
    moves: [],
  },
}

const WEIGHTS: Record<Direction, Partial<Record<StyleId, number>>> = {
  lift: { filterswap: 3, echo: 2, eqswap: 2, cut: 1, blend: 1, layer: 1, stems: 3 },
  hold: { layer: 3, eqswap: 2, blend: 2, filterswap: 1, echo: 1, stems: 3 },
  cool: { layer: 3, blend: 2, filterswap: 1, echo: 1, stems: 2 },
}

/** "Surprise me": a weighted pick that suits the energy and never repeats the last style. */
export function pickRecipe(direction: Direction, haveStems: boolean, last?: StyleId, rand = Math.random): Recipe {
  const options = (Object.entries(WEIGHTS[direction]) as [StyleId, number][]).filter(([id]) => id !== last && (haveStems || !RECIPES[id].needsStems))
  const total = options.reduce((s, [, w]) => s + w, 0)
  let r = rand() * total
  for (const [id, w] of options) if ((r -= w) < 0) return RECIPES[id]
  return RECIPES[options.at(-1)![0]]
}
