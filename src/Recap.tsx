import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { camelotHue } from '../shared/camelot.ts'
import { sessionStats, tracklistText, type Session } from '../shared/session.ts'
import { fetchSessions, saveSession } from './api.ts'
import type { SessionTracker } from './audio/sessionTracker.ts'
import { KeyChip } from './Sidebar.tsx'

const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const fmtDate = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** BPM over the set, as a small line chart with a dot per track. */
function EnergyCurve({ s }: { s: Session }) {
  const st = sessionStats(s)
  if (st.curve.length < 2) return <p className="hint">The energy curve appears once two analysed tracks have played.</p>
  const W = 560, H = 140, P = 24
  const maxMin = Math.max(1, st.minutes, ...st.curve.map((c) => c.min))
  const lo = Math.min(...st.curve.map((c) => c.bpm)) - 2, hi = Math.max(...st.curve.map((c) => c.bpm)) + 2
  const x = (m: number) => P + (m / maxMin) * (W - 2 * P)
  const y = (b: number) => H - P - ((b - lo) / (hi - lo || 1)) * (H - 2 * P)
  const path = st.curve.map((c, i) => `${i ? 'L' : 'M'}${x(c.min).toFixed(1)},${y(c.bpm).toFixed(1)}`).join(' ')
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`BPM from ${st.bpmMin} to ${st.bpmMax} across ${st.minutes} minutes`}>
      <line x1={P} x2={W - P} y1={H - P} y2={H - P} className="axis" />
      <text x={P} y={H - 6} className="tick">0:00</text>
      <text x={W - P} y={H - 6} className="tick" textAnchor="end">{st.minutes} min</text>
      <text x={4} y={y(hi - 2) + 4} className="tick">{Math.round(hi - 2)}</text>
      <text x={4} y={y(lo + 2) + 4} className="tick">{Math.round(lo + 2)}</text>
      <path d={path} className="line" />
      {st.curve.map((c, i) => <circle key={i} cx={x(c.min)} cy={y(c.bpm)} r={4} className="pt"><title>{`${Math.round(c.bpm)} BPM at ${Math.round(c.min)} min`}</title></circle>)}
    </svg>
  )
}

/** The square image for socials, drawn on a canvas in the current look. */
function drawCard(cv: HTMLCanvasElement, s: Session) {
  const st = sessionStats(s)
  const S = 1080
  cv.width = cv.height = S
  const g = cv.getContext('2d')!
  const look = document.documentElement.dataset.look
  const accent = cssVar('--accent') || '#a78bfa', mix = cssVar('--mix') || '#5eead4'
  const fg = '#f5f4fb', muted = 'rgba(245,244,251,0.62)'
  const display = look === 'console' ? '"Space Grotesk", system-ui, sans-serif' : '"Manrope", system-ui, sans-serif'
  const mono = look === 'console' ? '"JetBrains Mono", monospace' : display
  // Background
  if (look === 'console') {
    g.fillStyle = '#050505'
    g.fillRect(0, 0, S, S)
    g.strokeStyle = '#141414'
    for (let i = 0; i <= S; i += 40) (g.beginPath(), g.moveTo(i, 0), g.lineTo(i, S), g.moveTo(0, i), g.lineTo(S, i), g.stroke())
  } else {
    g.fillStyle = '#0b0b14'
    g.fillRect(0, 0, S, S)
    for (const [cx, cy, r, c] of [[150, -60, 760, 'rgba(124,58,237,0.55)'], [1080, 1150, 700, 'rgba(14,165,233,0.45)'], [760, 260, 520, 'rgba(236,72,153,0.22)']] as const) {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r)
      grad.addColorStop(0, c)
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, S, S)
    }
  }
  const P = 80
  g.fillStyle = look === 'console' ? mix : accent
  g.font = `700 26px ${mono}`
  g.fillText(look === 'console' ? 'S E L E C T O R' : 'Selector', P, P + 10)
  g.fillStyle = muted
  g.font = `500 26px ${display}`
  g.textAlign = 'right'
  g.fillText(new Date(s.startedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }), S - P, P + 10)
  g.textAlign = 'left'
  g.fillStyle = fg
  g.font = `800 64px ${display}`
  wrap(g, s.name, P, P + 120, S - 2 * P, 72, 2)
  // Stats row
  const stats = [
    [`${st.minutes}`, 'minutes'], [`${st.tracks}`, 'tracks'],
    [st.bpmMin ? (st.bpmMin === st.bpmMax ? `${st.bpmMin}` : `${st.bpmMin}–${st.bpmMax}`) : '–', 'BPM'],
    [st.harmonicPct !== null ? `${st.harmonicPct}%` : '–', 'in key'],
  ]
  const col = (S - 2 * P) / 4
  // One size for all four numbers, shrunk until the widest fits its column.
  let size = 60
  g.font = `800 ${size}px ${mono}`
  while (size > 30 && Math.max(...stats.map(([v]) => g.measureText(v).width)) > col - 24) g.font = `800 ${(size -= 2)}px ${mono}`
  stats.forEach(([v, l], i) => {
    const x = P + i * col
    g.fillStyle = fg
    g.font = `800 ${size}px ${mono}`
    g.fillText(v, x, 380)
    g.fillStyle = muted
    g.font = `600 22px ${display}`
    g.fillText(l.toUpperCase(), x, 414)
  })
  // Energy curve
  const curve = st.curve
  if (curve.length > 1) {
    const top = 460, h = 170, maxMin = Math.max(1, st.minutes, ...curve.map((c) => c.min))
    const lo = Math.min(...curve.map((c) => c.bpm)) - 2, hi = Math.max(...curve.map((c) => c.bpm)) + 2
    const px = (m: number) => P + (m / maxMin) * (S - 2 * P), py = (b: number) => top + h - ((b - lo) / (hi - lo || 1)) * h
    g.strokeStyle = look === 'console' ? mix : accent
    g.lineWidth = 6
    g.lineJoin = 'round'
    g.beginPath()
    curve.forEach((c, i) => (i ? g.lineTo(px(c.min), py(c.bpm)) : g.moveTo(px(c.min), py(c.bpm))))
    g.stroke()
    curve.forEach((c) => {
      g.fillStyle = fg
      g.beginPath()
      g.arc(px(c.min), py(c.bpm), 8, 0, Math.PI * 2)
      g.fill()
    })
  }
  // Tracklist (first 8)
  g.font = `600 27px ${display}`
  const list = s.tracks.slice(0, 8)
  list.forEach((t, i) => {
    const y = 700 + i * 40
    if (t.key) {
      g.fillStyle = `hsl(${camelotHue(t.key)} 70% 62%)`
      g.font = `700 22px ${mono}`
      g.fillText(t.key, P, y)
    }
    g.fillStyle = fg
    g.font = `600 27px ${display}`
    const line = `${t.artist ? `${t.artist} – ` : ''}${t.title}`
    g.fillText(fit(g, line, S - 2 * P - 70), P + 70, y)
  })
  if (s.tracks.length > 8) {
    g.fillStyle = muted
    g.font = `500 24px ${display}`
    g.fillText(`+ ${s.tracks.length - 8} more`, P + 70, 700 + 8 * 40)
  }
}

function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text
  let t = text
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1)
  return `${t}…`
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number, lines: number) {
  const words = text.split(' ')
  let line = '', row = 0
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (g.measureText(test).width > max && line) {
      g.fillText(row === lines - 1 ? fit(g, `${line} ${words.slice(words.indexOf(w)).join(' ')}`, max) : line, x, y + row * lh)
      if (++row >= lines) return
      line = w
    } else line = test
  }
  g.fillText(line, x, y + row * lh)
}

export function Recap({ open, onClose, tracker }: { open: boolean; onClose: () => void; tracker: SessionTracker }) {
  const ref = useRef<HTMLDialogElement>(null)
  const card = useRef<HTMLCanvasElement>(null)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => tracker.subscribe(bump), [tracker])
  const [past, setPast] = useState<Session[]>([])
  const [pick, setPick] = useState<string>()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      fetchSessions().then(setPast, () => setPast([]))
    }
    if (!open && d.open) d.close()
  }, [open])

  const live = tracker.current
  const sessions = useMemo(() => {
    const list = past.filter((p) => p.id !== live?.id)
    return live ? [live, ...list] : list
  }, [past, live, live?.tracks.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = sessions.find((x) => x.id === pick) ?? sessions[0]
  const st = s ? sessionStats(s) : undefined

  useEffect(() => {
    if (open && s && card.current) void document.fonts.ready.then(() => card.current && drawCard(card.current, s))
  }, [open, s, s?.tracks.length, s?.name])

  const rename = (name: string) => {
    if (!s) return
    if (s.id === live?.id) tracker.rename(name)
    else {
      const next = { ...s, name }
      setPast((p) => p.map((x) => (x.id === s.id ? next : x)))
      void saveSession(next)
    }
  }
  async function copy() {
    if (!s) return
    try {
      await navigator.clipboard.writeText(tracklistText(s))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked: the list is selectable below */
    }
  }
  function saveImage() {
    card.current?.toBlob((blob) => {
      if (!blob || !s) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${s.name.replace(/[^\w\s-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'selector-set'}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }, 'image/png')
  }

  return (
    <dialog ref={ref} className="recap panel" aria-labelledby="recap-h" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="recap-body">
        <div className="section-head">
          <h2 id="recap-h">Set recap</h2>
          <div className="recap-actions">
            {sessions.length > 1 && (
              <select value={s?.id} onChange={(e) => setPick(e.target.value)} aria-label="Choose a session">
                {sessions.map((x) => <option key={x.id} value={x.id}>{x.id === live?.id ? '● Live: ' : ''}{x.name}</option>)}
              </select>
            )}
            {s && s.id === live?.id && <button type="button" className="pill" onClick={() => tracker.endSet()}>End set</button>}
            <button type="button" className="pill" onClick={onClose}>Close <kbd>Esc</kbd></button>
          </div>
        </div>

        {!s || !st ? (
          <p className="hint">No sets yet. Play a track (with its fader up and the crossfader toward it) for 20 seconds and Selector starts logging your set.</p>
        ) : (
          <div className="recap-grid">
            <div className="recap-main">
              <input className="recap-name" value={s.name} onChange={(e) => rename(e.target.value)} aria-label="Set name" />
              <p className="hint">{fmtDate(s.startedAt)}{s.id === live?.id ? ' · recording live' : ''}</p>
              <div className="tiles">
                <div><b>{st.minutes}</b><span>minutes</span></div>
                <div><b>{st.tracks}</b><span>tracks</span></div>
                <div><b>{st.bpmMin ? (st.bpmMin === st.bpmMax ? st.bpmMin : `${st.bpmMin}–${st.bpmMax}`) : '–'}</b><span>BPM</span></div>
                <div><b>{st.harmonicPct !== null ? `${st.harmonicPct}%` : '–'}</b><span>transitions in key</span></div>
              </div>
              <h3>Energy</h3>
              <EnergyCurve s={s} />
              <h3>Key journey</h3>
              <div className="keypath">{st.keyPath.length ? st.keyPath.map((k, i) => <span key={i}>{i > 0 && <span className="arrow">→</span>}<KeyChip k={k} /></span>) : <span className="hint">No analysed keys yet.</span>}</div>
              <div className="section-head"><h3>Tracklist</h3><button type="button" className="pill" onClick={copy}>{copied ? '✓ Copied' : 'Copy tracklist'}</button></div>
              <ol className="tracklist">
                {s.tracks.map((t, i) => (
                  <li key={i}>
                    <span className="ts">{tracklistText({ ...s, tracks: [t] }).split(' ')[0]}</span>
                    <span className="tl-title">{t.artist ? `${t.artist} – ` : ''}{t.title}</span>
                    <KeyChip k={t.key} />
                    {t.via === 'automix' && <span className="via" title="Mixed in by automix">auto</span>}
                  </li>
                ))}
              </ol>
            </div>
            <div className="recap-card">
              <h3>Share card</h3>
              <canvas ref={card} aria-label="Shareable recap image" />
              <button type="button" className="send" onClick={saveImage}>Save image</button>
              <p className="hint">Square 1080×1080, ready for Instagram or TikTok. It uses your current look; switch to {document.documentElement.dataset.look === 'console' ? 'Glass' : 'Console'} for the other style.</p>
            </div>
          </div>
        )}
      </div>
    </dialog>
  )
}
