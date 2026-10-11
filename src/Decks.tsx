import { useEffect, useReducer, useRef, useState, type CSSProperties } from 'react'
import { getMixer, STEM_GROUPS, type Deck, type Mixer, type StemGroup } from './audio/engine.ts'
import { startStems, stemStatus, type StemStatus } from './api.ts'
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
        const colors = { low: cssVar('--wf-low'), mid: cssVar('--wf-mid'), high: cssVar('--wf-high'), grid: cssVar('--wf-grid'), cue: cssVar('--wf-cue'), head: cssVar('--fg') }
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

const KEY_HINTS = { A: { play: 'Q', cue: 'A', sync: 'S' }, B: { play: 'P', cue: 'L', sync: 'K' } }

function DeckPanel({ deck, other }: { deck: Deck; other: Deck }) {
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
    <section className={`deck deck-${deck.name.toLowerCase()}`} aria-label={`Deck ${deck.name}`}>
      <div className="deck-head">
        <span className="deck-name">{deck.name}</span>
        <div className="deck-track">
          <div className="deck-title" key={t?.id ?? 'empty'}>{t ? t.title : 'Empty deck'}</div>
          <div className="deck-artist" key={`a-${t?.id ?? 'empty'}`}>{st.error ?? (st.loading ? 'Loading…' : t?.artist ?? 'Press A or B on a track in the list')}</div>
        </div>
        <div className="deck-bpm">
          <span className="big">{deck.liveBpm ? deck.liveBpm.toFixed(1) : '–'}</span>
          <small>{st.rate !== 1 ? `${Number(pct) > 0 ? '+' : ''}${pct}%` : 'BPM'}</small>
        </div>
        <KeyChip k={t?.key ?? null} />
      </div>
      <Overview deck={deck} />
      <div className="deck-time">
        <span>{fmt(pos)}</span>
        <span>−{fmt(deck.duration - pos)}</span>
      </div>
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
      <StemControls deck={deck} />
      <Knob label="Tempo" value={st.rate} min={0.92} max={1.08} center={1} onChange={(v) => deck.setRate(v)} className="tempo" />
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

function ChannelStrip({ deck }: { deck: Deck }) {
  const [eq, setEq] = useState({ high: 0.5, mid: 0.5, low: 0.5, filter: 0, fader: 1 })
  const set = (k: keyof typeof eq, v: number) => {
    setEq((s) => ({ ...s, [k]: v }))
    if (k === 'filter') deck.channel.setFilter(v)
    else if (k === 'fader') deck.channel.setFader(v)
    else deck.channel.setEq(k, v)
  }
  return (
    <div className="strip" aria-label={`Channel ${deck.name}`}>
      {(['high', 'mid', 'low'] as const).map((b) => (
        <Knob key={b} label={b === 'high' ? 'Hi' : b === 'mid' ? 'Mid' : 'Low'} value={eq[b]} onChange={(v) => set(b, v)} className={eq[b] <= 0.02 ? 'killed' : ''} />
      ))}
      <Knob label="Filter" value={eq.filter} min={-1} max={1} center={0} onChange={(v) => set('filter', v)} />
      <Knob label={`Ch ${deck.name}`} value={eq.fader} center={1} onChange={(v) => set('fader', v)} className="fader" />
    </div>
  )
}

function MixerPanel({ mixer }: { mixer: Mixer }) {
  const [x, setX] = useState(mixer.crossfader)
  return (
    <section className="mixer" aria-label="Mixer">
      <div className="strips">
        <ChannelStrip deck={mixer.decks.A} />
        <ChannelStrip deck={mixer.decks.B} />
      </div>
      <Knob label="A ⟷ B" value={x} onChange={(v) => (setX(v), mixer.setCrossfader(v))} className="xfader" />
    </section>
  )
}

export function DeckArea() {
  const mixer = getMixer()
  return (
    <div className="decks panel" style={{ '--x': 0 } as CSSProperties}>
      <Waveforms mixer={mixer} />
      <div className="deck-row">
        <DeckPanel deck={mixer.decks.A} other={mixer.decks.B} />
        <MixerPanel mixer={mixer} />
        <DeckPanel deck={mixer.decks.B} other={mixer.decks.A} />
      </div>
    </div>
  )
}
