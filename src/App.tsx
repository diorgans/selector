import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { harmonicNeighbors, mixesWell } from '../shared/camelot.ts'
import type { Library, Track } from '../shared/types.ts'
import { fetchLibrary, fetchSets, saveSets, type SetList } from './api.ts'
import { CamelotWheel } from './CamelotWheel.tsx'
import { getMixer } from './audio/engine.ts'
import { getAutomix } from './audio/automix.ts'
import { getTracker } from './audio/sessionTracker.ts'
import { Recap } from './Recap.tsx'
import { openVisuals, startVisualsLink } from './visualsLink.ts'
import { BackgroundVisuals } from './Visuals.tsx'
import { capDevicePixelRatio } from './dpr.ts'
import { DeckArea } from './Decks.tsx'
import { withTransition } from './motion.ts'
import { folderGroupId, folderTree, inFolder, libraryGroups, type FolderNode } from './libraryGroups.ts'
import { Shortcuts } from './Shortcuts.tsx'
import { LibraryTools } from './LibraryTools.tsx'
import { applyGrids } from './grid.ts'
import { ControllerSetup } from './ControllerSetup.tsx'
import { connect as connectMidi, loadMap as loadMidiMap, setBrowseHandlers, startController } from './midi.ts'
import { restoreOutput } from './output.ts'
import { trackDrag } from './dnd.ts'
import { KeyChip, SetBuilder, UpNext } from './Sidebar.tsx'

type SortKey = 'title' | 'artist' | 'bpm' | 'key' | 'durationSec' | 'playCount'
type Look = 'glass' | 'console'

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
// Sort keys by wheel position (1A, 1B, 2A…) rather than alphabetically (10A before 1A).
const keyOrder = (k: string | null) => (k ? Number(k.slice(0, -1)) * 2 + (k.endsWith('B') ? 1 : 0) : 99)

/** A drive's folders as a nested list; folders with subfolders open with ▸. */
function FolderList({ nodes, depth, crate, pick }: { nodes: FolderNode[]; depth: number; crate: string; pick: (id: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  return (
    <ul className="folders" role="group">
      {nodes.map((n) => {
        const id = folderGroupId(n.path)
        const isOpen = open.has(n.path)
        return (
          <li key={n.path}>
            <div className="crate-row" style={{ paddingLeft: depth * 12 }}>
              {n.children.length > 0 ? (
                <button type="button" className="twisty" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} folders in ${n.name}`} onClick={() => setOpen((s) => { const x = new Set(s); if (x.has(n.path)) x.delete(n.path); else x.add(n.path); return x })}>{isOpen ? '▾' : '▸'}</button>
              ) : <span className="twisty-space" />}
              <button type="button" className={crate === id ? 'crate on' : 'crate'} onClick={() => pick(id)} title={n.path}>
                <span className="crate-name">{n.name.replace(/^\[[^\]]+\]\s*/, '') || n.name}</span><span className="count">{n.count}</span>
              </button>
            </div>
            {isOpen && <FolderList nodes={n.children} depth={depth + 1} crate={crate} pick={pick} />}
          </li>
        )
      })}
    </ul>
  )
}

export function App() {
  const [lib, setLib] = useState<Library>()
  const [error, setError] = useState<string>()
  // Sidebar source: the music files Noah owns, or his Apple Music playlists. Remembered between visits.
  const [source, setSourceState] = useState<'library' | 'apple'>(() => {
    try {
      return localStorage.getItem('selector-source') === 'apple' ? 'apple' : 'library'
    } catch {
      return 'library'
    }
  })
  const [crate, setCrate] = useState<string>(() => (source === 'library' ? 'lib:all' : 'all'))
  const setSource = (s: 'library' | 'apple') =>
    withTransition(() => {
      setSourceState(s)
      setCrate(s === 'library' ? 'lib:all' : 'all')
      try {
        localStorage.setItem('selector-source', s)
      } catch {
        /* remembered for this visit only */
      }
    }, 'crate')
  const [showKeys, setShowKeys] = useState(false)
  const [showController, setShowController] = useState(false)
  // Which drives are expanded into folders in the sidebar (remembered).
  const [openDrives, setOpenDrives] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('selector-open-drives') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggleDrive = (d: string) =>
    setOpenDrives((s) => {
      const n = new Set(s)
      if (n.has(d)) n.delete(d)
      else n.add(d)
      try {
        localStorage.setItem('selector-open-drives', JSON.stringify([...n]))
      } catch {
        /* this visit only */
      }
      return n
    })
  // If the controller was set up before, reconnect it quietly on load.
  useEffect(() => {
    if (Object.keys(loadMidiMap()).length) connectMidi().then(startController, () => {})
    void restoreOutput() // back to the controller's sound card if it was chosen before
  }, [])
  const [query, setQuery] = useState('')
  const [keyFilter, setKeyFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<{ by: SortKey; dir: 1 | -1 }>({ by: 'bpm', dir: 1 })
  const [selected, setSelected] = useState<Track>()
  const [look, setLook] = useState<Look>(() => (new URLSearchParams(location.search).get('look') as Look) ?? 'glass')

  const [tab, setTab] = useState<'next' | 'set' | 'keys'>('next')
  const [set, setSet] = useState<SetList>({ id: 'set-1', name: 'Selector set', trackIds: [] })

  const reloadLibrary = useCallback(() => {
    fetchLibrary().then((l) => setLib({ ...l, tracks: applyGrids(l.tracks) }), () => {})
  }, [])
  useEffect(() => {
    fetchLibrary().then((l) => setLib({ ...l, tracks: applyGrids(l.tracks) }), (e) => setError(String(e.message ?? e)))
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
    if (crate === 'all') return lib.tracks.filter((t) => !t.id.startsWith('f')) // the rekordbox collection
    if (crate.startsWith('lib:folder:')) {
      const path = crate.slice('lib:folder:'.length)
      return lib.tracks.filter((t) => t.source === 'file' && inFolder(t, path))
    }
    const ids = new Set(
      crate.startsWith('lib:') ? libraryGroups(lib.tracks).find((g) => g.id === crate)?.trackIds : lib.crates.find((c) => c.id === crate)?.trackIds,
    )
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
  // Automix reads the latest library, set and selection through refs, so it's created once.
  const live = useRef({ lib, set, selected })
  live.current = { lib, set, selected }
  const [automix] = useState(
    () =>
      getAutomix(getMixer(), {
        pool: () => live.current.lib?.tracks ?? [],
        set: () => live.current.set.trackIds,
        first: () => {
          const { lib, set, selected } = live.current
          if (selected?.playable) return selected
          return set.trackIds.map((id) => lib?.tracks.find((t) => t.id === id)).find((t) => t?.playable)
        },
      }),
  )

  const [tracker] = useState(() => getTracker(getMixer(), automix))
  useEffect(() => startVisualsLink(getMixer()), [])
  // Visuals behind the player: off, behind the decks, or the whole background. Remembered.
  const [visualsMode, setVisualsModeState] = useState<'off' | 'decks' | 'page'>(() => {
    try {
      const v = localStorage.getItem('selector-visuals')
      return v === 'decks' || v === 'page' ? v : 'off'
    } catch {
      return 'off'
    }
  })
  if (visualsMode !== 'off') capDevicePixelRatio(1.25) // keep the decks smooth while shaders run
  const setVisualsMode = (v: string) => {
    if (v === 'window') return openVisuals()
    withTransition(() => setVisualsModeState(v as 'off' | 'decks' | 'page'), 'look')
    try {
      localStorage.setItem('selector-visuals', v)
    } catch {
      /* this visit only */
    }
  }
  const [showRecap, setShowRecap] = useState(false)

  const loadTo = (deck: 'A' | 'B', t: Track) => {
    setSelected(t)
    void getMixer().decks[deck].load(t)
  }

  // Keyboard: Q/P play A/B · A/L cue · S/K sync · Z/M load selected track into A/B · ←/→ crossfader.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === '?') {
        setShowKeys((v) => !v)
        return e.preventDefault()
      }
      if (e.key === '/' && !el.closest('input, textarea, select')) {
        document.querySelector<HTMLInputElement>('.top input[type=search]')?.focus()
        return e.preventDefault()
      }
      if (showKeys || showRecap || showController || el.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey) return
      const m = getMixer(), { A, B } = m.decks
      const act: Record<string, () => void> = {
        q: () => A.toggle(), p: () => B.toggle(), a: () => A.cue(), l: () => B.cue(),
        s: () => A.syncTo(B), k: () => B.syncTo(A),
        d: () => A.autoLoop(), j: () => B.autoLoop(),
        e: () => A.channel.fx.slots[0].setOn(!A.channel.fx.slots[0].on), i: () => B.channel.fx.slots[0].setOn(!B.channel.fx.slots[0].on),
        z: () => selected?.playable && loadTo('A', selected), m: () => selected?.playable && loadTo('B', selected),
        ArrowLeft: () => m.setCrossfader(m.crossfader - 0.05), ArrowRight: () => m.setCrossfader(m.crossfader + 0.05),
      }
      const fn = act[e.key.length === 1 ? e.key.toLowerCase() : e.key]
      if (fn) {
        fn()
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The controller's browse knob moves the selection; LOAD sends it to a deck.
  // While the knob turns, only a highlight moves (direct and cheap, so every song it
  // passes is visible); the full selection (suggestions, wheel) follows once it stops.
  const browseState = useRef({ visible: [] as Track[], selected: undefined as Track | undefined, cursor: undefined as Track | undefined, timer: 0 })
  browseState.current.visible = visible
  browseState.current.selected = selected
  useEffect(() => {
    setBrowseHandlers({
      move: (steps) => {
        const b = browseState.current
        if (!b.visible.length) return
        const from = b.cursor ?? b.selected
        const i = from ? b.visible.findIndex((t) => t.id === from.id) : -1
        const next = b.visible[Math.max(0, Math.min(b.visible.length - 1, i + steps))]
        b.cursor = next
        document.querySelector('tbody tr.cursor')?.classList.remove('cursor')
        const row = document.querySelector(`tbody tr[data-id="${CSS.escape(next.id)}"]`)
        row?.classList.add('cursor')
        row?.scrollIntoView({ block: 'nearest' })
        clearTimeout(b.timer)
        b.timer = window.setTimeout(() => {
          setSelected(next)
          b.cursor = undefined
          document.querySelector('tbody tr.cursor')?.classList.remove('cursor')
        }, 220)
      },
      load: (deck) => {
        const t = browseState.current.cursor ?? browseState.current.selected
        if (t?.playable) {
          setSelected(t)
          void getMixer().decks[deck].load(t)
        }
      },
    })
  }, [])

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
    <div className={`app${visualsMode === 'page' ? ' with-bg-visuals' : ''}`}>
      {visualsMode === 'page' && <BackgroundVisuals mode="page" />}
      <aside className="side panel">
        <div className="brand">Selector</div>
        <div className="source" role="tablist" aria-label="Music source">
          <button type="button" role="tab" aria-selected={source === 'library'} onClick={() => setSource('library')}>My Library</button>
          <button type="button" role="tab" aria-selected={source === 'apple'} onClick={() => setSource('apple')}>Apple Music</button>
        </div>
        <nav aria-label={source === 'library' ? 'My music files' : 'Apple Music playlists'}>
          {source === 'library' ? (
            <>
              {libraryGroups(lib.tracks).filter((g, i) => i < 2 || g.trackIds.length > 0).map((g) => {
                const drive = g.id.startsWith('lib:drive:') ? g.id.slice('lib:drive:'.length) : null
                const folders = drive ? folderTree(lib.tracks, `/Volumes/${drive}`) : []
                const open = drive ? openDrives.has(drive) : false
                return (
                  <div key={g.id} className="crate-group">
                    <div className="crate-row">
                      {drive && folders.length > 0 && (
                        <button type="button" className="twisty" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} folders on ${drive}`} onClick={() => toggleDrive(drive)}>{open ? '▾' : '▸'}</button>
                      )}
                      <button type="button" className={crate === g.id ? 'crate on' : 'crate'} title={g.hint} onClick={() => withTransition(() => setCrate(g.id), 'crate')}>
                        <span className="crate-name">{g.name}</span><span className="count">{g.trackIds.length}</span>
                      </button>
                    </div>
                    {open && <FolderList nodes={folders} depth={1} crate={crate} pick={(id) => withTransition(() => setCrate(id), 'crate')} />}
                  </div>
                )
              })}
              {lib.stats.playable < 10 && (
                <p className="side-note">Add music: download songs in the Music app (select › right-click › Download) or plug in a drive and press Add below.</p>
              )}
              <LibraryTools lib={lib} onChanged={reloadLibrary} />
            </>
          ) : (
            <>
              <button type="button" className={crate === 'all' ? 'crate on' : 'crate'} title="Everything in your rekordbox collection, including Apple Music streaming" onClick={() => withTransition(() => setCrate('all'), 'crate')}>
                <span className="crate-name">All rekordbox tracks</span><span className="count">{lib.tracks.filter((t) => !t.id.startsWith('f')).length}</span>
              </button>
              <div className="side-label">Playlists</div>
              {crates.filter((c) => c.trackIds.length > 0).map((c) => (
                <button key={c.id} type="button" className={crate === c.id ? 'crate on' : 'crate'} onClick={() => withTransition(() => setCrate(c.id), 'crate')} title={`${c.trackIds.length} of ${c.totalItems} songs are in rekordbox`}>
                  <span className="crate-name">{c.name}</span><span className="count">{c.trackIds.length}</span>
                </button>
              ))}
            </>
          )}
        </nav>
      </aside>

      <main className="main">
        <DeckArea resolve={(id) => tracksById.get(id)} onLoaded={setSelected} automix={automix} visuals={visualsMode === 'decks'} />
        <header className="top panel">
          <input type="search" placeholder="Search title, artist, genre" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tracks" />
          {keyFilter && (
            <button type="button" className="pill" onClick={() => withTransition(() => setKeyFilter(null), 'crate')}>Mixes with <KeyChip k={keyFilter} /> ✕</button>
          )}
          {selected && <span className="legend"><span className="mix-dot" aria-hidden /> {mixable.size} mix well with {selected.title}</span>}
          {!selected && <span className="stats">{visible.length} tracks · {lib.stats.analyzed} analyzed · {lib.stats.streaming} streaming</span>}
          <label className="pill visuals-pick" title="Shader visuals that follow the music">
            Visuals
            <select value={visualsMode} onChange={(e) => setVisualsMode(e.target.value)}>
              <option value="off">Off</option>
              <option value="decks">Behind decks</option>
              <option value="page">Whole background</option>
              <option value="window">New window ↗</option>
            </select>
          </label>
          <button type="button" className="pill" onClick={() => setShowController(true)} aria-haspopup="dialog">🎛 Controller</button>
          <button type="button" className="pill" onClick={() => setShowRecap(true)} aria-haspopup="dialog">Recap</button>
          <button type="button" className="pill keys-btn" onClick={() => setShowKeys(true)} aria-haspopup="dialog">⌨ Keys <kbd>?</kbd></button>
          <div className="look" role="group" aria-label="Design direction">
            {(['glass', 'console'] as Look[]).map((l) => (
              <button key={l} type="button" aria-pressed={look === l} onClick={() => withTransition(() => setLook(l), 'look')}>{l === 'glass' ? 'A · Glass' : 'B · Console'}</button>
            ))}
          </div>
        </header>

        <div className="table-wrap panel">
          <table>
            <thead>
              <tr>
                <th className="load-h"><span className="th-plain">Load</span></th>
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
                <tr key={t.id} data-id={t.id} className={`${selected?.id === t.id ? 'sel' : mixable.has(t.id) ? 'mix' : ''}${t.playable ? '' : ' locked'}`} onClick={() => setSelected(t)} {...trackDrag(t)}>
                  <td className="load">
                    {t.playable ? (
                      <>
                        <button type="button" onClick={(e) => (e.stopPropagation(), loadTo('A', t))} aria-label={`Load ${t.title} to deck A`}>A</button>
                        <button type="button" onClick={(e) => (e.stopPropagation(), loadTo('B', t))} aria-label={`Load ${t.title} to deck B`}>B</button>
                      </>
                    ) : (
                      <span className="lock" title={t.source === 'streaming' ? 'Apple Music streaming: play it in rekordbox' : t.blocked === 'protected' ? 'Copy-protected Apple download' : 'File not found: is the drive plugged in?'}>
                        {t.source === 'streaming' ? '☁' : t.blocked === 'protected' ? '🔒' : '⏏'}
                      </span>
                    )}
                  </td>
                  <td className="title">{mixable.has(t.id) && <span className="mix-dot" title="Mixes well with the selected track" />}{t.title}</td>
                  <td className="artist">{t.artist}</td>
                  <td className="num">{t.bpm ? t.bpm.toFixed(t.bpm % 1 ? 1 : 0) : '–'}</td>
                  <td><KeyChip k={t.key} /></td>
                  <td className="num">{fmtTime(t.durationSec)}</td>
                  <td className="num">{t.playCount || ''}</td>
                  <td><span className={`src src-${t.source}`}>{t.source === 'streaming' ? 'Stream' : t.playable ? 'File' : t.blocked === 'protected' ? 'Protected' : 'Offline'}</span></td>
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
            <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} onClick={() => withTransition(() => setTab(id), 'tab')}>{label}</button>
          ))}
        </div>
        <div className="tab-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'next' && (selected
            ? <UpNext lib={lib} current={selected} pool={inCrate} exclude={inSet} onPick={setSelected} onAdd={addToSet} />
            : <p className="hint">Suggestions appear here once you pick a track.</p>)}
          {tab === 'set' && <SetBuilder set={set} tracksById={tracksById} onChange={setSet} onSelect={setSelected} />}
          {tab === 'keys' && (
            <div className="keys">
              <CamelotWheel counts={keyCounts} selected={selected?.key ?? keyFilter} onPick={(k) => withTransition(() => setKeyFilter((f) => (f === k ? null : k)), 'crate')} />
              <p className="hint">Brighter slices have more tracks in this crate. Outlined slices mix with the selected key. Click a slice to show only tracks that mix with it.</p>
            </div>
          )}
        </div>
      </aside>
      <Shortcuts open={showKeys} onClose={() => setShowKeys(false)} />
      <Recap open={showRecap} onClose={() => setShowRecap(false)} tracker={tracker} />
      <ControllerSetup open={showController} onClose={() => setShowController(false)} />
    </div>
  )
}
