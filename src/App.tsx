import { useEffect, useMemo, useRef, useState } from 'react'
import { harmonicNeighbors, mixesWell } from '../shared/camelot.ts'
import type { Library, Track } from '../shared/types.ts'
import { fetchLibrary, fetchSets, saveSets, type SetList } from './api.ts'
import { CamelotWheel } from './CamelotWheel.tsx'
import { KeyChip, SetBuilder, UpNext } from './Sidebar.tsx'

type SortKey = 'title' | 'artist' | 'bpm' | 'key' | 'durationSec' | 'playCount'
type Look = 'glass' | 'console'

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
// Sort keys by wheel position (1A, 1B, 2A…) rather than alphabetically (10A before 1A).
const keyOrder = (k: string | null) => (k ? Number(k.slice(0, -1)) * 2 + (k.endsWith('B') ? 1 : 0) : 99)

export function App() {
  const [lib, setLib] = useState<Library>()
  const [error, setError] = useState<string>()
  const [crate, setCrate] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [keyFilter, setKeyFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<{ by: SortKey; dir: 1 | -1 }>({ by: 'bpm', dir: 1 })
  const [selected, setSelected] = useState<Track>()
  const [look, setLook] = useState<Look>(() => (new URLSearchParams(location.search).get('look') as Look) ?? 'glass')

  const [tab, setTab] = useState<'next' | 'set' | 'keys'>('next')
  const [set, setSet] = useState<SetList>({ id: 'set-1', name: 'Selector set', trackIds: [] })

  useEffect(() => {
    fetchLibrary().then(setLib, (e) => setError(String(e.message ?? e)))
    fetchSets().then((s) => s[0] && setSet(s[0]), () => {})
  }, [])
  // Save the set shortly after each change (one set for now; the file holds a list for later).
  const firstSave = useRef(true)
  useEffect(() => {
    if (firstSave.current) return void (firstSave.current = false)
    const t = setTimeout(() => saveSets([set]).catch(() => {}), 400)
    return () => clearTimeout(t)
  }, [set])
  useEffect(() => {
    document.documentElement.dataset.look = look
  }, [look])

  const inCrate = useMemo(() => {
    if (!lib) return []
    if (crate === 'all') return lib.tracks
    const ids = new Set(lib.crates.find((c) => c.id === crate)?.trackIds)
    return lib.tracks.filter((t) => ids.has(t.id))
  }, [lib, crate])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const near = keyFilter ? new Set(harmonicNeighbors(keyFilter)) : null
    const rows = inCrate.filter(
      (t) => (!q || `${t.title} ${t.artist} ${t.genre}`.toLowerCase().includes(q)) && (!near || (t.key && near.has(t.key))),
    )
    const val = (t: Track) => (sort.by === 'key' ? keyOrder(t.key) : (t[sort.by] ?? -1))
    return rows.sort((a, b) => {
      const x = val(a), y = val(b)
      return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir
    })
  }, [inCrate, query, keyFilter, sort])

  const keyCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of inCrate) if (t.key) m.set(t.key, (m.get(t.key) ?? 0) + 1)
    return m
  }, [inCrate])

  // Tracks that mix well with the selected one: neighbouring key and a tempo the pitch fader can reach.
  const mixable = useMemo(
    () => new Set(selected ? visible.filter((t) => t.id !== selected.id && mixesWell(selected, t)).map((t) => t.id) : []),
    [selected, visible],
  )

  const tracksById = useMemo(() => new Map((lib?.tracks ?? []).map((t) => [t.id, t])), [lib])
  const inSet = useMemo(() => new Set(set.trackIds), [set])
  const addToSet = (t: Track) => {
    setSet((s) => ({ ...s, trackIds: [...s.trackIds, t.id] }))
    setSelected(t) // keep chaining from the track just added
  }

  if (error) return <main className="empty"><h1>Selector</h1><p>{error}</p></main>
  if (!lib) return <main className="empty"><p>Reading your library…</p></main>

  const header = (by: SortKey, label: string, cls = '') => (
    <th className={cls} aria-sort={sort.by === by ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort((s) => ({ by, dir: s.by === by ? (-s.dir as 1 | -1) : 1 }))}>
        {label}{sort.by === by ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )
  const crates = [...lib.crates].sort((a, b) => b.trackIds.length - a.trackIds.length)

  return (
    <div className="app">
      <aside className="side panel">
        <div className="brand">Selector</div>
        <nav aria-label="Crates">
          <button type="button" className={crate === 'all' ? 'crate on' : 'crate'} onClick={() => setCrate('all')}>
            <span>All tracks</span><span className="count">{lib.tracks.length}</span>
          </button>
          <div className="side-label">Apple Music playlists</div>
          {crates.filter((c) => c.trackIds.length > 0).map((c) => (
            <button key={c.id} type="button" className={crate === c.id ? 'crate on' : 'crate'} onClick={() => setCrate(c.id)} title={`${c.trackIds.length} of ${c.totalItems} songs are in rekordbox`}>
              <span className="crate-name">{c.name}</span><span className="count">{c.trackIds.length}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="top panel">
          <input type="search" placeholder="Search title, artist, genre" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tracks" />
          {keyFilter && (
            <button type="button" className="pill" onClick={() => setKeyFilter(null)}>Mixes with <KeyChip k={keyFilter} /> ✕</button>
          )}
          {selected && <span className="legend"><span className="mix-dot" aria-hidden /> {mixable.size} mix well with {selected.title}</span>}
          {!selected && <span className="stats">{visible.length} tracks · {lib.stats.analyzed} analyzed · {lib.stats.streaming} streaming</span>}
          <div className="look" role="group" aria-label="Design direction">
            {(['glass', 'console'] as Look[]).map((l) => (
              <button key={l} type="button" aria-pressed={look === l} onClick={() => setLook(l)}>{l === 'glass' ? 'A · Glass' : 'B · Console'}</button>
            ))}
          </div>
        </header>

        <div className="table-wrap panel">
          <table>
            <thead>
              <tr>
                {header('title', 'Title')}
                {header('artist', 'Artist')}
                {header('bpm', 'BPM', 'num')}
                {header('key', 'Key')}
                {header('durationSec', 'Time', 'num')}
                {header('playCount', 'Plays', 'num')}
                <th><span className="th-plain">Source</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} className={selected?.id === t.id ? 'sel' : mixable.has(t.id) ? 'mix' : ''} onClick={() => setSelected(t)}>
                  <td className="title">{mixable.has(t.id) && <span className="mix-dot" title="Mixes well with the selected track" />}{t.title}</td>
                  <td className="artist">{t.artist}</td>
                  <td className="num">{t.bpm ? t.bpm.toFixed(t.bpm % 1 ? 1 : 0) : '–'}</td>
                  <td><KeyChip k={t.key} /></td>
                  <td className="num">{fmtTime(t.durationSec)}</td>
                  <td className="num">{t.playCount || ''}</td>
                  <td><span className={`src src-${t.source}`}>{t.source === 'streaming' ? 'Stream' : 'File'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      <aside className="detail panel">
        {selected ? (
          <div className="now">
            <div className="now-label">Selected</div>
            <div className="now-row">
              <div className="now-text">
                <div className="now-title">{selected.title}</div>
                <div className="now-artist">{selected.artist}</div>
              </div>
              <span className="big">{selected.bpm?.toFixed(0) ?? '–'}<small>BPM</small></span>
              <KeyChip k={selected.key} />
            </div>
            <button type="button" className="pill" disabled={inSet.has(selected.id)} onClick={() => addToSet(selected)}>{inSet.has(selected.id) ? '✓ In set' : '＋ Add to set'}</button>
          </div>
        ) : (
          <p className="hint">Pick a track to see what mixes with it.</p>
        )}

        <div className="tabs" role="tablist" aria-label="Panels">
          {([['next', 'Up next'], ['set', `Set · ${set.trackIds.length}`], ['keys', 'Keys']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="tab-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'next' && (selected
            ? <UpNext lib={lib} current={selected} pool={inCrate} exclude={inSet} onPick={setSelected} onAdd={addToSet} />
            : <p className="hint">Suggestions appear here once you pick a track.</p>)}
          {tab === 'set' && <SetBuilder set={set} tracksById={tracksById} onChange={setSet} onSelect={setSelected} />}
          {tab === 'keys' && (
            <div className="keys">
              <CamelotWheel counts={keyCounts} selected={selected?.key ?? keyFilter} onPick={(k) => setKeyFilter((f) => (f === k ? null : k))} />
              <p className="hint">Brighter slices have more tracks in this crate. Outlined slices mix with the selected key. Click a slice to show only tracks that mix with it.</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
