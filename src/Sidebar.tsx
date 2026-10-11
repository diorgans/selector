import { useMemo, useState } from 'react'
import { camelotHue, mixesWell } from '../shared/camelot.ts'
import { suggestNext, type Direction } from '../shared/recommend.ts'
import type { Library, Track } from '../shared/types.ts'
import { exportSets, type SetList } from './api.ts'
import { vtName, withTransition } from './motion.ts'

export function KeyChip({ k }: { k: string | null }) {
  if (!k) return <span className="key key-none">–</span>
  return <span className="key" style={{ ['--h' as string]: camelotHue(k) }}>{k}</span>
}

const DIRECTIONS: { id: Direction; label: string; hint: string }[] = [
  { id: 'lift', label: 'Lift', hint: 'Raise the energy: a bit faster or one step up the wheel' },
  { id: 'hold', label: 'Hold', hint: 'Keep the groove: same tempo and key area' },
  { id: 'cool', label: 'Cool', hint: 'Bring it down: a bit slower or one step back' },
]

/** "Up next": ranked suggestions for the selected track, each with its reasons. */
export function UpNext({ lib, current, pool, exclude, onPick, onAdd }: {
  lib: Library; current: Track; pool: Track[]; exclude: Set<string>; onPick: (t: Track) => void; onAdd: (t: Track) => void
}) {
  const [direction, setDirection] = useState<Direction>('hold')
  const crateNames = useMemo(() => new Map(lib.crates.map((c) => [c.id, c.name])), [lib])
  const suggestions = useMemo(
    () => suggestNext(current, pool, { direction, exclude, crateNames, limit: 8 }),
    [current, pool, direction, exclude, crateNames],
  )
  return (
    <section className="upnext" aria-labelledby="upnext-h">
      <div className="section-head">
        <h2 id="upnext-h">Up next</h2>
        <div className="seg" role="group" aria-label="Energy direction">
          {DIRECTIONS.map((d) => (
            <button key={d.id} type="button" aria-pressed={direction === d.id} title={d.hint} onClick={() => withTransition(() => setDirection(d.id), 'reorder')}>{d.label}</button>
          ))}
        </div>
      </div>
      {!current.key || !current.bpm ? (
        <p className="hint">This track has no BPM or key yet. Analyze it in rekordbox and re-export.</p>
      ) : suggestions.length === 0 ? (
        <p className="hint">Nothing in view mixes with this one. Try “All tracks” or another direction.</p>
      ) : (
        <ol className="sugs">
          {suggestions.map((s) => (
            <li key={s.track.id} className="sug" style={{ viewTransitionName: vtName('sug', s.track.id) }}>
              <button type="button" className="sug-main" onClick={() => onPick(s.track)}>
                <span className="sug-score" aria-label={`Score ${s.score} of 100`}>{s.score}</span>
                <span className="sug-text">
                  <span className="sug-title">{s.track.title}</span>
                  <span className="sug-artist">{s.track.artist}</span>
                </span>
                <KeyChip k={s.track.key} />
              </button>
              <button type="button" className="add" aria-label={`Add ${s.track.title} to the set`} onClick={() => onAdd(s.track)}>＋</button>
              <ul className="reasons" aria-label="Why">
                {s.reasons.map((r) => <li key={r.label} className={`reason ${r.tone}`}>{r.label}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The set being built: order, transition checks, and the hand-off to rekordbox. */
export function SetBuilder({ set, tracksById, onChange, onSelect }: {
  set: SetList; tracksById: Map<string, Track>; onChange: (s: SetList) => void; onSelect: (t: Track) => void
}) {
  const [status, setStatus] = useState<string>()
  const tracks = set.trackIds.map((id) => tracksById.get(id)).filter((t): t is Track => !!t)
  const move = (i: number, by: number) => {
    const ids = [...set.trackIds]
    const [x] = ids.splice(i, 1)
    ids.splice(i + by, 0, x)
    onChange({ ...set, trackIds: ids })
  }
  async function send() {
    setStatus('Writing…')
    try {
      const r = await exportSets([set])
      setStatus(`Saved ${r.sets} set${r.sets === 1 ? '' : 's'} to ${r.path.replace(/^.*\/Music\//, 'Music/')}. In rekordbox, refresh the “rekordbox xml” list.`)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }
  const minutes = Math.round(tracks.reduce((n, t) => n + t.durationSec, 0) / 60)
  return (
    <section className="setb" aria-labelledby="set-h">
      <div className="section-head">
        <h2 id="set-h">Set</h2>
        <span className="count">{tracks.length} tracks · {minutes} min</span>
      </div>
      <input className="set-name" value={set.name} aria-label="Set name" onChange={(e) => onChange({ ...set, name: e.target.value })} />
      {tracks.length === 0 ? (
        <p className="hint">Pick a track, then press ＋ on a suggestion to chain the next one.</p>
      ) : (
        <ol className="setlist">
          {tracks.map((t, i) => {
            const prev = tracks[i - 1]
            const ok = prev ? mixesWell(prev, t) : true
            return (
              <li key={`${t.id}-${i}`}>
                {prev && <span className={`join ${ok ? 'ok' : 'warn'}`}>{ok ? '✓ mixes' : '⚠ key or tempo clash'}</span>}
                <div className="set-row">
                  <span className="set-n">{i + 1}</span>
                  <button type="button" className="set-title" onClick={() => onSelect(t)}>{t.title}<span>{t.artist}</span></button>
                  <KeyChip k={t.key} />
                  <span className="set-ctl">
                    <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" aria-label="Move down" disabled={i === tracks.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button type="button" aria-label={`Remove ${t.title}`} onClick={() => onChange({ ...set, trackIds: set.trackIds.filter((_, j) => j !== i) })}>✕</button>
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <button type="button" className="send" disabled={tracks.length === 0} onClick={send}>Send to rekordbox</button>
      {status && <p className="status" role="status">{status}</p>}
    </section>
  )
}
