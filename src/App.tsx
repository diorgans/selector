import { useEffect, useMemo, useState } from 'react'
import { camelotHue, harmonicNeighbors, mixesWell } from '../shared/camelot.ts'
import type { Library, Track } from '../shared/types.ts'
import { fetchLibrary } from './api.ts'
import { CamelotWheel } from './CamelotWheel.tsx'

type SortKey = 'title' | 'artist' | 'bpm' | 'key' | 'durationSec' | 'playCount'
type Look = 'glass' | 'console'

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
// Sort keys by wheel position (1A, 1B, 2A…) rather than alphabetically (10A before 1A).
const keyOrder = (k: string | null) => (k ? Number(k.slice(0, -1)) * 2 + (k.endsWith('B') ? 1 : 0) : 99)

function KeyChip({ k }: { k: string | null }) {
  if (!k) return <span className="key key-none">–</span>
  return <span className="key" style={{ ['--h' as string]: camelotHue(k) }}>{k}</span>
}

export function App() {
  const [lib, setLib] = useState<Library>()
  const [error, setError] = useState<string>()
  const [crate, setCrate] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [keyFilter, setKeyFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<{ by: SortKey; dir: 1 | -1 }>({ by: 'bpm', dir: 1 })
  const [selected, setSelected] = useState<Track>()
  const [look, setLook] = useState<Look>(() => (new URLSearchParams(location.search).get('look') as Look) ?? 'glass')

  useEffect(() => {
    fetchLibrary().then(setLib, (e) => setError(String(e.message ?? e)))
  }, [])
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
        <CamelotWheel counts={keyCounts} selected={selected?.key ?? keyFilter} onPick={(k) => setKeyFilter((f) => (f === k ? null : k))} />
        {selected ? (
          <div className="now">
            <div className="now-label">Selected</div>
            <div className="now-title">{selected.title}</div>
            <div className="now-artist">{selected.artist}</div>
            <div className="now-meta">
              <span className="big">{selected.bpm?.toFixed(0) ?? '–'}<small>BPM</small></span>
              <KeyChip k={selected.key} />
            </div>
            {selected.key && (
              <button type="button" className="pill" onClick={() => setKeyFilter(selected.key)}>Show tracks that mix with {selected.key}</button>
            )}
          </div>
        ) : (
          <p className="hint">Pick a track to see which keys mix with it. Click a slice to filter by key.</p>
        )}
      </aside>
    </div>
  )
}
