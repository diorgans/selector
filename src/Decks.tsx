import { useEffect, useReducer, useRef, useState, type CSSProperties } from 'react'
import { audio, getMixer, STEM_GROUPS, type Deck, type Mixer, type StemGroup } from './audio/engine.ts'
import type { Automix, AutomixSettings } from './audio/automix.ts'
import { RECIPES } from './audio/recipes.ts'
import { BEAT_CHOICES, FX_INFO, type FxType } from './audio/fx.ts'
import { BackgroundVisuals } from './Visuals.tsx'
import { PHRASE_COLORS, whereAmI } from './audio/phrases.ts'
import { startStems, stemStatus, type StemStatus } from './api.ts'
import { isTrackDrag, TRACK_MIME } from './dnd.ts'
import type { Track } from '../shared/types.ts'
import { saveGrid } from './grid.ts'
import { KeyChip } from './Sidebar.tsx'

const HOT_CUES = 'ABCDEFGH'
const fmt = (s: number) => {
  const t = Math.max(0, s)
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`
}

/** Re-render when a deck's state changes (load, play, rate…). */
function useDeck(deck: Deck) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => deck.subscribe(bump), [deck])
  return deck.state
}

/** Re-render every animation frame while something plays (for clocks and meters). */
function useFrame(active: boolean) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!active) return
    let id = requestAnimationFrame(function loop() {
      bump()
      id = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(id)
  }, [active])
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// --- Waveforms ------------------------------------------------------------

const WINDOW_SEC = 8 // seconds visible in the scrolling view at normal speed

/** Both decks' scrolling waveforms, stacked like rekordbox, with beatgrids and cues. */
function Waveforms({ mixer }: { mixer: Mixer }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let id = 0
    const draw = () => {
      const cv = ref.current
      if (cv) {
        const dpr = Math.min(devicePixelRatio, 2)
        const w = cv.clientWidth, h = cv.clientHeight
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
          cv.width = Math.round(w * dpr)
          cv.height = Math.round(h * dpr)
        }
        const g = cv.getContext('2d')!
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, h)
        const colors = { low: cssVar('--wf-low'), mid: cssVar('--wf-mid'), high: cssVar('--wf-high'), grid: cssVar('--wf-grid'), cue: cssVar('--wf-cue'), head: cssVar('--fg'), loop: cssVar('--wf-loop') }
        const lane = h / 2
        ;(['A', 'B'] as const).forEach((name, i) => drawLane(g, mixer.decks[name], 0, i * lane, w, lane, colors))
        g.fillStyle = colors.head
        g.fillRect(Math.round(w / 2) - 1, 0, 2, h)
      }
      id = requestAnimationFrame(draw)
    }
    id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [mixer])
  return <canvas ref={ref} className="waves" aria-label="Deck waveforms" role="img" />
}

function drawLane(g: CanvasRenderingContext2D, deck: Deck, x0: number, y0: number, w: number, h: number, c: Record<string, string>) {
  const wf = deck.waveform
  const mid = y0 + h / 2
  g.fillStyle = c.grid
  g.fillRect(x0, y0 + h - 1, w, 1)
  if (!wf) {
    g.fillStyle = c.grid
    g.font = '12px system-ui'
    g.fillText(deck.state.loading ? `Loading deck ${deck.name}…` : `Deck ${deck.name}: load a track`, x0 + 12, mid + 4)
    return
  }
  const pos = deck.position()
  const secPerPx = WINDOW_SEC / w
  const t0 = pos - (w / 2) * secPerPx
  // Beatgrid: thin lines on beats, brighter on bar starts.
  if (deck.bpm) {
    const beat = 60 / deck.bpm
    const first = deck.state.track?.firstBeatSec ?? 0
    for (let k = Math.ceil((t0 - first) / beat); first + k * beat < t0 + WINDOW_SEC; k++) {
      const x = x0 + (first + k * beat - t0) / secPerPx
      g.fillStyle = c.grid
      g.globalAlpha = k % 4 === 0 ? 0.9 : 0.35
      g.fillRect(Math.round(x), y0, 1, h)
    }
    g.globalAlpha = 1
  }
  for (let px = 0; px < w; px++) {
    const t = t0 + px * secPerPx
    if (t < 0 || t > deck.duration) continue
    const bin = Math.floor(t * wf.binsPerSecond)
    const lo = wf.low[bin] ?? 0, md = wf.mid[bin] ?? 0, hi = wf.high[bin] ?? 0
    const amp = h * 0.46
    g.globalAlpha = t < pos ? 0.55 : 1
    g.fillStyle = c.low
    g.fillRect(x0 + px, mid - lo * amp, 1, lo * amp * 2)
    g.fillStyle = c.mid
    g.fillRect(x0 + px, mid - md * amp * 0.75, 1, md * amp * 1.5)
    g.fillStyle = c.high
    g.fillRect(x0 + px, mid - hi * amp * 0.45, 1, hi * amp * 0.9)
  }
  g.globalAlpha = 1
  // Phrases: a coloured strip along the bottom of the lane, named where each starts.
  if (deck.phrases.length) {
    g.font = 'bold 9px system-ui'
    for (const p of deck.phrases) {
      const xa = x0 + (p.start - t0) / secPerPx, xb = x0 + (p.end - t0) / secPerPx
      if (xb < 0 || xa > w) continue
      g.fillStyle = PHRASE_COLORS[p.kind]
      g.globalAlpha = 0.85
      g.fillRect(Math.max(x0, xa) + 1, y0 + h - 6, Math.min(w, xb) - Math.max(x0, xa) - 2, 5)
      g.globalAlpha = 1
      if (xa >= 0) g.fillText(p.kind.toUpperCase(), xa + 4, y0 + h - 9)
    }
  }
  // Active loop: a shaded band between its start and end.
  const loop = deck.state.loop
  if (loop) {
    const xa = x0 + (loop.start - t0) / secPerPx, xb = x0 + (loop.end - t0) / secPerPx
    g.fillStyle = c.loop
    g.fillRect(Math.max(x0, xa), y0, Math.min(w, xb) - Math.max(x0, xa), h)
  }
  // Cue point and hot cues.
  const marks = [{ t: deck.cuePoint, label: 'CUE' }, ...(deck.state.track?.cues ?? []).filter((q) => q.num >= 0).map((q) => ({ t: q.timeSec, label: HOT_CUES[q.num] }))]
  for (const m of marks) {
    const x = x0 + (m.t - t0) / secPerPx
    if (x < 0 || x > w) continue
    g.fillStyle = c.cue
    g.fillRect(Math.round(x), y0, 2, h)
    g.font = 'bold 10px system-ui'
    g.fillText(m.label, x + 4, y0 + 12)
  }
  g.fillStyle = c.head
  g.font = 'bold 11px system-ui'
  g.fillText(deck.name, x0 + 8, y0 + 14)
}

/** Whole-track overview; click to jump. */
function Overview({ deck }: { deck: Deck }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let id = 0
    const draw = () => {
      const cv = ref.current, wf = deck.waveform
      if (cv) {
        const dpr = Math.min(devicePixelRatio, 2)
        const w = cv.clientWidth, h = cv.clientHeight
        if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr)
        if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr)
        const g = cv.getContext('2d')!
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, w, h)
        if (wf && deck.duration) {
          const per = wf.low.length / w
          const played = (deck.position() / deck.duration) * w
          for (let px = 0; px < w; px++) {
            let lo = 0, hi = 0
            for (let j = Math.floor(px * per); j < (px + 1) * per; j++) {
              lo = Math.max(lo, wf.low[j] ?? 0)
              hi = Math.max(hi, wf.mid[j] ?? 0)
            }
            g.globalAlpha = px < played ? 0.4 : 1
            g.fillStyle = cssVar('--wf-low')
            g.fillRect(px, h / 2 - (lo * h) / 2, 1, lo * h)
            g.fillStyle = cssVar('--wf-mid')
            g.fillRect(px, h / 2 - (hi * h) / 3, 1, (hi * h * 2) / 3)
          }
          g.globalAlpha = 1
          for (const p of deck.phrases) {
            g.fillStyle = PHRASE_COLORS[p.kind]
            g.fillRect((p.start / deck.duration) * w + 0.5, h - 4, ((p.end - p.start) / deck.duration) * w - 1, 4)
          }
          g.fillStyle = cssVar('--fg')
          g.fillRect(Math.round(played), 0, 2, h)
        }
      }
      id = requestAnimationFrame(draw)
    }
    id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [deck])
  return (
    <canvas
      ref={ref}
      className="overview"
      aria-label={`Deck ${deck.name} overview: click to jump`}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        deck.seek(((e.clientX - r.left) / r.width) * deck.duration)
      }}
    />
  )
}

// --- Controls ---------------------------------------------------------------

/** A compact slider that snaps back to centre on double-click. */
function Knob({ label, value, onChange, min = 0, max = 1, center = 0.5, vertical = false, className = '' }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; center?: number; vertical?: boolean; className?: string
}) {
  return (
    <label className={`knob ${vertical ? 'vertical' : ''} ${className}`} onDoubleClick={() => onChange(center)}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={0.001} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    </label>
  )
}

/** Bar and beat (four lights), the current phrase, and bars left before the next one. */
function BeatCounter({ deck, pos }: { deck: Deck; pos: number }) {
  const t = deck.state.track
  if (!t?.bpm || !deck.buffer) return <span className="beatcount muted">{t && !t.bpm ? 'beatgrid after analysis' : ''}</span>
  const w = whereAmI(pos, t.firstBeatSec ?? 0, t.bpm, deck.phrases)
  return (
    <span className="beatcount" aria-label={`Bar ${w.bar}, beat ${w.beat}${w.phrase ? `, ${w.phrase.kind}` : ''}`}>
      <span className="bar">BAR {Math.max(1, w.bar)}</span>
      <span className="lights" aria-hidden>{[1, 2, 3, 4].map((i) => <i key={i} className={i === w.beat ? (i === 1 ? 'on one' : 'on') : ''} />)}</span>
      {w.phrase && (
        <span className="phrase" style={{ ['--pc' as string]: PHRASE_COLORS[w.phrase.kind] }}>
          {w.phrase.kind.toUpperCase()} · {w.barsLeft!.toFixed(1)} bars left
        </span>
      )}
    </span>
  )
}

const KEY_HINTS = { A: { play: 'Q', cue: 'A', sync: 'S' }, B: { play: 'P', cue: 'L', sync: 'K' } }

function DeckPanel({ deck, other, onDropTrack }: { deck: Deck; other: Deck; onDropTrack: (id: string) => void }) {
  const [over, setOver] = useState(false)
  const st = useDeck(deck)
  const keys = KEY_HINTS[deck.name]
  useFrame(st.playing)
  const t = st.track
  const pos = deck.position()
  const pct = ((st.rate - 1) * 100).toFixed(1)
  const hold = (fn: () => () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      const release = fn()
      const up = () => (release(), window.removeEventListener('pointerup', up))
      window.addEventListener('pointerup', up)
      e.preventDefault()
    },
  })
  return (
    <section
      className={`deck deck-${deck.name.toLowerCase()}${over ? ' drop-over' : ''}`}
      aria-label={`Deck ${deck.name}`}
      data-drop-label={`Drop to load on deck ${deck.name}`}
      onDragOver={(e) => {
        if (!isTrackDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(TRACK_MIME)
        setOver(false)
        if (!id) return
        e.preventDefault()
        onDropTrack(id)
      }}
    >
      <div className="deck-head">
        <span className="deck-name">{deck.name}</span>
        <div className="deck-track">
          <div className="deck-title" key={t?.id ?? 'empty'}>{t ? t.title : 'Empty deck'}</div>
          <div className="deck-artist" key={`a-${t?.id ?? 'empty'}`}>{st.error ?? (st.loading ? 'Loading…' : t?.artist ?? 'Press A or B on a track in the list')}</div>
        </div>
        <div className="deck-bpm">
          <span className="big">{deck.liveBpm ? deck.liveBpm.toFixed(1) : '–'}</span>
          <small>{st.rate !== 1 ? `${Number(pct) > 0 ? '+' : ''}${pct}%` : t && !t.bpm ? 'analyzing…' : 'BPM'}</small>
        </div>
        <KeyChip k={t?.key ?? null} />
      </div>
      <Overview deck={deck} />
      <div className="deck-time">
        <span>{fmt(pos)}</span>
        <span>−{fmt(deck.duration - pos)}</span>
      </div>
      <BeatCounter deck={deck} pos={pos} />
      <div className="transport">
        <button type="button" className="tbtn cue" onClick={() => deck.cue()} disabled={!deck.buffer} aria-keyshortcuts={keys.cue} aria-label={`Cue deck ${deck.name} (${keys.cue})`}>CUE<kbd>{keys.cue}</kbd></button>
        <button type="button" className={`tbtn play ${st.playing ? 'on' : ''}`} onClick={() => deck.toggle()} disabled={!deck.buffer} aria-pressed={st.playing} aria-keyshortcuts={keys.play} aria-label={`${st.playing ? 'Pause' : 'Play'} deck ${deck.name} (${keys.play})`}>{st.playing ? '❚❚' : '▶'}<kbd>{keys.play}</kbd></button>
        <button type="button" className={`tbtn sync ${st.synced ? 'on' : ''}`} onClick={() => deck.syncTo(other)} disabled={!deck.buffer || !other.buffer || !deck.bpm} aria-pressed={st.synced} title="Match the other deck's tempo and line up the beats" aria-keyshortcuts={keys.sync} aria-label={`Sync deck ${deck.name} (${keys.sync})`}>SYNC<kbd>{keys.sync}</kbd></button>
        <span className="nudge">
          <button type="button" aria-label="Nudge slower" {...hold(() => deck.nudge(-0.04))} disabled={!st.playing}>‹</button>
          <button type="button" aria-label="Nudge faster" {...hold(() => deck.nudge(0.04))} disabled={!st.playing}>›</button>
        </span>
        <span className="jump">
          <button type="button" onClick={() => deck.beatJump(-4)} disabled={!deck.bpm}>−4</button>
          <button type="button" onClick={() => deck.beatJump(4)} disabled={!deck.bpm}>+4</button>
        </span>
      </div>
      <div className="hotcues" role="group" aria-label="Hot cues">
        {HOT_CUES.split('').map((letter, i) => {
          const cue = t?.cues?.find((c) => c.num === i)
          return <button key={letter} type="button" disabled={!cue || !deck.buffer} onClick={() => deck.hotCue(i)} title={cue ? cue.name || `Hot cue ${letter}` : `No hot cue ${letter} (set them in rekordbox)`}>{letter}</button>
        })}
      </div>
      <LoopControls deck={deck} />
      <StemControls deck={deck} />
      <FxControls deck={deck} />
      <TempoControl deck={deck} />
    </section>
  )
}

const STAGE_LABEL: Record<string, string> = {
  starting: 'Starting…', 'loading-model': 'Loading the AI model…', decoding: 'Reading the file…', separating: 'Separating', saving: 'Saving stems…',
}
const GROUP_LABEL: Record<StemGroup, string> = { vocals: 'Vocals', instruments: 'Instruments', drums: 'Drums' }

/** Split a song into vocals / instruments / drums, then mix them live. */
function StemControls({ deck }: { deck: Deck }) {
  const st = useDeck(deck)
  const id = st.track?.playable ? st.track.id : undefined
  const [status, setStatus] = useState<StemStatus>()
  const [muted, setMuted] = useState<Partial<Record<StemGroup, number>>>({}) // level to restore on unmute

  // Check the cache when a track loads; poll while a split is running.
  useEffect(() => {
    setStatus(undefined)
    setMuted({})
    if (!id) return
    let stop = false
    let timer = 0
    const check = async () => {
      try {
        const s = await stemStatus(id)
        if (stop) return
        setStatus(s)
        if (s.state === 'ready') {
          if (!deck.state.stemsLoaded && deck.state.track?.id === id && !deck.state.loading) await deck.loadStems(id)
        } else if (s.state === 'queued' || s.state === 'running') timer = window.setTimeout(check, 700)
      } catch (e) {
        if (!stop) setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    }
    void check()
    const unsub = deck.subscribe(() => {
      // Once the full track finishes loading, pick up stems that were already cached.
      if (!deck.state.loading && !deck.state.stemsLoaded && deck.state.track?.id === id) void check()
    })
    return () => {
      stop = true
      clearTimeout(timer)
      unsub()
    }
  }, [id, deck])

  async function split() {
    if (!id) return
    try {
      setStatus(await startStems(id))
      const poll = async () => {
        const s = await stemStatus(id)
        setStatus(s)
        if (s.state === 'ready') await deck.loadStems(id)
        else if (s.state === 'queued' || s.state === 'running') setTimeout(poll, 700)
      }
      setTimeout(poll, 700)
    } catch (e) {
      setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  if (!id) return null
  if (st.stemsLoaded) {
    return (
      <div className="stems" role="group" aria-label={`Deck ${deck.name} stems`}>
        {(Object.keys(STEM_GROUPS) as StemGroup[]).map((g) => {
          const level = st.stemLevels[g]
          const isMuted = level === 0
          return (
            <div key={g} className={`stem ${isMuted ? 'muted' : ''}`}>
              <button
                type="button"
                aria-pressed={!isMuted}
                aria-label={`${isMuted ? 'Unmute' : 'Mute'} ${GROUP_LABEL[g]} on deck ${deck.name}`}
                onClick={() => {
                  if (isMuted) deck.setStemLevel(g, muted[g] || 1)
                  else (setMuted((m) => ({ ...m, [g]: level })), deck.setStemLevel(g, 0))
                }}
              >{GROUP_LABEL[g]}</button>
              <input type="range" min={0} max={1} step={0.01} value={level} aria-label={`${GROUP_LABEL[g]} level, deck ${deck.name}`} onChange={(e) => deck.setStemLevel(g, Number(e.target.value))} onDoubleClick={() => deck.setStemLevel(g, 1)} />
            </div>
          )
        })}
      </div>
    )
  }
  const busy = status?.state === 'queued' || status?.state === 'running'
  return (
    <div className="stems-cta">
      {busy ? (
        <div className="stem-progress" role="status">
          <span>{status?.state === 'queued' ? 'Queued: another song is splitting first…' : `${STAGE_LABEL[status?.stage ?? 'starting'] ?? 'Working…'}${status?.stage === 'separating' && status.progress ? ` ${Math.round(status.progress * 100)}%` : ''}`}</span>
          <span className="bar"><span style={{ width: `${Math.round((status?.progress ?? 0) * 100)}%` }} /></span>
        </div>
      ) : status?.state === 'ready' ? (
        <span className="hint">Loading stems…</span>
      ) : (
        <>
          <button type="button" className="pill" onClick={split} disabled={st.loading || status?.installed === false}>✂ Split stems</button>
          <span className="hint">{status?.state === 'error' ? status.message : 'Vocals · instruments · drums, on your Mac (~20–40 s)'}</span>
        </>
      )}
    </div>
  )
}

/** Tempo: slider, a box to type an exact BPM, and a one-click reset to the song's own tempo. */
function TempoControl({ deck }: { deck: Deck }) {
  const st = useDeck(deck)
  const bpm = deck.bpm
  const live = deck.liveBpm
  const [draft, setDraft] = useState<string>()
  const commit = () => {
    const v = Number(draft)
    setDraft(undefined)
    if (bpm && v > 0) deck.setRate(v / bpm) // clamped to ±16% by the deck
  }
  return (
    <div className="tempo-row">
      <Knob label="Tempo" value={st.rate} min={0.92} max={1.08} center={1} onChange={(v) => deck.setRate(v)} className="tempo" />
      <label className="bpm-input">
        <span className="sr-only">Type a BPM for deck {deck.name}</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          disabled={!bpm}
          value={draft ?? (live ? live.toFixed(1) : '')}
          placeholder="BPM"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') (setDraft(undefined), (e.target as HTMLInputElement).blur())
          }}
        />
      </label>
      <button type="button" className="keylock" aria-pressed={st.keyLock} onClick={() => void deck.setKeyLock(!st.keyLock)} title="Key lock: change the tempo without changing the pitch">
        🔒 Key
      </button>
      <button type="button" className="reset" disabled={!bpm || Math.abs(st.rate - 1) < 0.0005} onClick={() => deck.setRate(1)} title={bpm ? `Back to the original ${bpm.toFixed(1)} BPM` : undefined}>
        Reset
      </button>
    </div>
  )
}

/** Automix: let Selector keep the music going, blending on the phrase. */
function AutomixPanel({ automix }: { automix: Automix }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => automix.subscribe(bump), [automix])
  const { on, status, next, mixAt, mixEnd, history } = automix.state
  const now = audio().currentTime
  const blending = !!mixAt && !!mixEnd && now >= mixAt
  useFrame(on && !!mixAt) // live countdown
  const s = automix.settings
  const secs = mixAt ? Math.max(0, mixAt - audio().currentTime) : 0
  const set = <K extends keyof AutomixSettings>(k: K, v: AutomixSettings[K]) => automix.configure({ [k]: v } as Partial<AutomixSettings>)
  return (
    <div className={`automix ${on ? 'on' : ''}`} aria-label="Automix">
      <button type="button" className="automix-toggle" aria-pressed={on} onClick={() => (on ? automix.stop() : void automix.start())}>
        <span className="dot" aria-hidden /> Automix {on ? 'on' : 'off'}
      </button>
      <div className="automix-settings">
        <label>Next<select value={s.source} onChange={(e) => set('source', e.target.value as AutomixSettings['source'])}>
          <option value="smart">Smart pick</option><option value="set">My set</option>
        </select></label>
        {s.source === 'smart' && (
          <label>Energy<select value={s.direction} onChange={(e) => set('direction', e.target.value as AutomixSettings['direction'])}>
            <option value="lift">Lift</option><option value="hold">Hold</option><option value="cool">Cool</option>
          </select></label>
        )}
        <label>Style<select value={s.style} onChange={(e) => set('style', e.target.value as AutomixSettings['style'])} title={s.style === 'surprise' ? 'A different transition each time, suited to the energy' : RECIPES[s.style].blurb}>
          <option value="surprise">✦ Surprise me</option>
          {Object.values(RECIPES).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select></label>
        {s.style !== 'cut' && s.style !== 'echo' && (
          <label>Length<select value={s.bars} onChange={(e) => set('bars', Number(e.target.value) as AutomixSettings['bars'])}>
            <option value={8}>8 bars</option><option value={16}>16 bars</option><option value={32}>32 bars</option>
          </select></label>
        )}
      </div>
      <label className="automix-stems">
        <input type="checkbox" checked={s.useStems} onChange={(e) => set('useStems', e.target.checked)} />
        Use stems (splits upcoming songs in the background for mashups)
      </label>
      <p className="automix-status" role="status">
        {status}
        {on && next && mixAt && !blending ? <> · in <b>{Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, '0')}</b></> : null}
        {on && blending ? <> · <b>{Math.min(100, Math.round(((now - mixAt!) / (mixEnd! - mixAt!)) * 100))}%</b></> : null}
        {on && history.length > 1 ? <> · {history.length} played</> : null}
      </p>
    </div>
  )
}

const FX_KEYS = { A: 'E', B: 'I' }
const beatLabel = (b: number) => (b === 0.25 ? '¼' : b === 0.5 ? '½' : b === 0.75 ? '¾' : String(b))

/** Three effect slots for one deck (like the DDJ-SR): pick each effect, its level and on/off; one shared beat length. */
function FxControls({ deck }: { deck: Deck }) {
  const rack = deck.channel.fx
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => rack.subscribe(bump), [rack])
  return (
    <div className="fxrack" role="group" aria-label={`Deck ${deck.name} effects`}>
      <div className="fxrack-head"><span className="fxrack-label">FX</span></div>
      <div className="fxslots">
        {rack.slots.map((fx, i) => {
          const info = FX_INFO[fx.type]
          return (
            <div key={i} className={`fxslot ${fx.on ? 'on' : ''}`}>
              <select value={fx.type} onChange={(e) => fx.setType(e.target.value as FxType)} aria-label={`Effect ${i + 1}, deck ${deck.name}`} title={info.hint}>
                {(Object.keys(FX_INFO) as FxType[]).map((t) => <option key={t} value={t}>{FX_INFO[t].name}</option>)}
              </select>
              <input type="range" min={0} max={1} step={0.01} value={fx.amount} onChange={(e) => fx.setAmount(Number(e.target.value))} aria-label={`${info.name} level, deck ${deck.name}`} onDoubleClick={() => fx.setAmount(0.5)} />
              <select className="fx-beat" value={fx.beats} disabled={!info.synced} onChange={(e) => fx.setBeats(Number(e.target.value))} aria-label={`${info.name} beats, deck ${deck.name}`} title={info.synced ? 'Beat length for this effect' : 'This effect doesn’t follow the beat'}>
                {BEAT_CHOICES.map((b) => <option key={b} value={b}>{beatLabel(b)} beat{b > 1 ? 's' : ''}</option>)}
              </select>
              <button type="button" className="fx-on" aria-pressed={fx.on} onClick={() => fx.setOn(!fx.on)} aria-label={`${fx.on ? 'Turn off' : 'Turn on'} ${info.name} (effect ${i + 1}) on deck ${deck.name}${i === 0 ? ` (${FX_KEYS[deck.name]})` : ''}`}>
                {i + 1}{i === 0 && <kbd>{FX_KEYS[deck.name]}</kbd>}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const loopLabel = (b: number) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`)
const LOOP_KEYS = { A: 'D', B: 'J' }

/** Loops: AUTO LOOP (beats), ½X / 2X, LOOP IN / OUT, RELOOP / EXIT. */
function LoopControls({ deck }: { deck: Deck }) {
  const st = useDeck(deck)
  const active = !!st.loop
  const off = !deck.buffer
  const save = (v: number | undefined) => v !== undefined && st.track && saveGrid(st.track.id, v)
  return (
    <div className={`loops ${active ? 'on' : ''}`} role="group" aria-label={`Deck ${deck.name} loops`}>
      <button type="button" className="loop-auto" aria-pressed={active} disabled={off} onClick={() => deck.autoLoop()} aria-keyshortcuts={LOOP_KEYS[deck.name]} title={`Loop ${loopLabel(st.loopBeats)} beats from here (${LOOP_KEYS[deck.name]})`}>
        LOOP {loopLabel(st.loopBeats)}<kbd>{LOOP_KEYS[deck.name]}</kbd>
      </button>
      <button type="button" disabled={off} onClick={() => deck.resizeLoop(0.5)} aria-label={`Halve deck ${deck.name} loop`}>½</button>
      <button type="button" disabled={off} onClick={() => deck.resizeLoop(2)} aria-label={`Double deck ${deck.name} loop`}>×2</button>
      <button type="button" disabled={off} className={deck.pendingLoopIn !== null ? 'armed' : ''} onClick={() => deck.setLoopIn()} title="Mark where a loop starts">IN</button>
      <button type="button" disabled={off || deck.pendingLoopIn === null} onClick={() => deck.setLoopOut()} title="Close the loop here (rounded to whole beats)">OUT</button>
      <button type="button" disabled={off} onClick={() => deck.reloop()} title={active ? 'Leave the loop' : 'Jump back into the last loop'}>{active ? 'EXIT' : 'RELOOP'}</button>
      <span className="grid-ctl" role="group" aria-label="Beatgrid">
        <span className="grid-label">GRID</span>
        <button type="button" disabled={off || !deck.bpm} onClick={() => save(deck.nudgeGrid(-0.01))} aria-label={`Move deck ${deck.name} beatgrid 10 ms earlier`}>◀</button>
        <button type="button" disabled={off || !deck.bpm} onClick={() => save(deck.nudgeGrid(0.01))} aria-label={`Move deck ${deck.name} beatgrid 10 ms later`}>▶</button>
        <button type="button" disabled={off || !deck.bpm} onClick={() => save(deck.setGridHere())} title="Pause or play with the playhead on a kick, then press: beat 1 goes here">SET</button>
      </span>
    </div>
  )
}

function ChannelStrip({ deck }: { deck: Deck }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => deck.channel.subscribe(bump), [deck])
  const k = deck.channel.knobs
  const ch = deck.channel
  return (
    <div className="strip" aria-label={`Channel ${deck.name}`}>
      <Knob label="Trim" value={k.trim} onChange={(v) => ch.setTrim(v)} />
      {(['high', 'mid', 'low'] as const).map((b) => (
        <Knob key={b} label={b === 'high' ? 'Hi' : b === 'mid' ? 'Mid' : 'Low'} value={k[b]} onChange={(v) => ch.setEq(b, v)} className={k[b] <= 0.02 ? 'killed' : ''} />
      ))}
      <Knob label="Filter" value={k.filter} min={-1} max={1} center={0} onChange={(v) => ch.setFilter(v)} />
      <Knob label={`Ch ${deck.name}`} value={k.fader} center={1} onChange={(v) => ch.setFader(v)} className="fader" />
      <button type="button" className="cue-btn" aria-pressed={k.cue === 1} onClick={() => ch.setCue(k.cue !== 1)} title="Hear this deck in your headphones (before its fader)">🎧 CUE</button>
    </div>
  )
}

/** Headphones: blend between the cued decks and the master, and the level. */
function PhonesControls({ mixer }: { mixer: Mixer }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => mixer.master.subscribe(bump), [mixer])
  const m = mixer.master
  return (
    <div className="phones" role="group" aria-label="Headphones">
      <Knob label="🎧 Cue ⟷ Master" value={m.phonesMix} center={0.25} onChange={(v) => m.setPhones(v, m.phonesLevel)} />
      <Knob label="🎧 Level" value={m.phonesLevel} center={0.8} onChange={(v) => m.setPhones(m.phonesMix, v)} />
      {m.outputChannels < 4 && <p className="phones-note">Headphones need the controller as the sound output: open 🎛 Controller › Sound output.</p>}
    </div>
  )
}

function MixerPanel({ mixer, children }: { mixer: Mixer; children?: React.ReactNode }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => mixer.subscribe(bump), [mixer])
  useFrame(!!mixer.xfadeRamp) // follow an automix crossfade as it happens
  return (
    <section className="mixer" aria-label="Mixer">
      <div className="strips">
        <ChannelStrip deck={mixer.decks.A} />
        <ChannelStrip deck={mixer.decks.B} />
      </div>
      <Knob label="A ⟷ B" value={mixer.crossfaderNow()} onChange={(v) => mixer.setCrossfader(v)} className="xfader" />
      <Knob label={`Master ${mixer.masterVolume === 0 ? '(muted)' : `${(-24 * (1 - mixer.masterVolume)).toFixed(0)} dB`}`} value={mixer.masterVolume} center={0.8} onChange={(v) => mixer.setMasterVolume(v)} className="master-vol" />
      <PhonesControls mixer={mixer} />
      {children}
    </section>
  )
}

export function DeckArea({ resolve, onLoaded, automix, visuals }: { resolve: (id: string) => Track | undefined; onLoaded?: (t: Track) => void; automix: Automix; visuals?: boolean }) {
  const mixer = getMixer()
  const drop = (name: 'A' | 'B') => (id: string) => {
    const t = resolve(id)
    if (!t?.playable) return
    void mixer.decks[name].load(t)
    onLoaded?.(t)
  }
  return (
    <div className={`decks panel${visuals ? ' with-visuals' : ''}`} style={{ '--x': 0 } as CSSProperties}>
      {visuals && <BackgroundVisuals mode="decks" />}
      <Waveforms mixer={mixer} />
      <div className="deck-row">
        <DeckPanel deck={mixer.decks.A} other={mixer.decks.B} onDropTrack={drop('A')} />
        <MixerPanel mixer={mixer}><AutomixPanel automix={automix} /></MixerPanel>
        <DeckPanel deck={mixer.decks.B} other={mixer.decks.A} onDropTrack={drop('B')} />
      </div>
    </div>
  )
}
