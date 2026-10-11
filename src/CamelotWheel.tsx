import { camelotHue, harmonicNeighbors } from '../shared/camelot.ts'

// 24 slices: majors (B) on the outer ring, minors (A) inside, 1 at the top.
// Brightness shows how many tracks in view are in each key; the selected
// track's key and the keys that mix cleanly with it are outlined.

const SIZE = 260
const C = SIZE / 2

function arc(r0: number, r1: number, i: number) {
  const a0 = ((i * 30 - 105) * Math.PI) / 180
  const a1 = (((i + 1) * 30 - 105) * Math.PI) / 180
  const p = (r: number, a: number) => `${C + r * Math.cos(a)} ${C + r * Math.sin(a)}`
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`
}

export function CamelotWheel({ counts, selected, onPick }: { counts: Map<string, number>; selected: string | null; onPick: (key: string) => void }) {
  const max = Math.max(1, ...counts.values())
  const near = new Set(selected ? harmonicNeighbors(selected) : [])
  const rings: { letter: 'A' | 'B'; r0: number; r1: number }[] = [
    { letter: 'B', r0: 84, r1: 126 },
    { letter: 'A', r0: 44, r1: 84 },
  ]
  return (
    <svg className="wheel" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label="Camelot wheel: keys in view">
      {rings.map(({ letter, r0, r1 }) =>
        Array.from({ length: 12 }, (_, i) => {
          const code = `${i + 1}${letter}`
          const n = counts.get(code) ?? 0
          const mid = ((i * 30 - 90) * Math.PI) / 180
          const r = (r0 + r1) / 2
          const state = code === selected ? 'is-selected' : near.has(code) ? 'is-near' : ''
          return (
            <g key={code} className={`slice ${state}`} onClick={() => onPick(code)} style={{ ['--h' as string]: camelotHue(code), ['--fill' as string]: 0.12 + 0.88 * (n / max) }}>
              <title>{`${code}: ${n} track${n === 1 ? '' : 's'}`}</title>
              <path d={arc(r0, r1, i)} />
              <text x={C + r * Math.cos(mid)} y={C + r * Math.sin(mid)} dominantBaseline="central" textAnchor="middle">{code}</text>
            </g>
          )
        }),
      )}
    </svg>
  )
}
