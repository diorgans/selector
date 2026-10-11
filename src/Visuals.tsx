import { useEffect, useRef, useState, type ComponentType } from 'react'
import * as Shaders from 'shaders/react'
import { camelotHue, parseCamelot } from '../shared/camelot.ts'
import { VISUALS_CHANNEL, type VisualFrame } from './visualsLink.ts'

// The visuals window: full-screen shader scenes driven by the music.
// Key → colour palette (smoothly), beat → pulses (bigger on the bar), loudness → intensity.

const S = Shaders as unknown as Record<string, ComponentType<Record<string, unknown>>>

type SceneId = 'aurora' | 'kaleido' | 'mesh' | 'rings'
const SCENES: { id: SceneId; name: string }[] = [
  { id: 'aurora', name: 'Aurora' },
  { id: 'kaleido', name: 'Kaleido' },
  { id: 'mesh', name: 'Mesh' },
  { id: 'rings', name: 'Rings' },
]

const hex = (h: number, s: number, l: number) => {
  // HSL (degrees, 0–1, 0–1) → #rrggbb
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}

/** Palette for a key: minor keys deeper and moodier, major keys brighter. */
function palette(hue: number, minor: boolean) {
  // The key's colour, a contrasting accent across the wheel, and a deep base,
  // so every key gives depth rather than a wash of one colour.
  const l = minor ? 0.46 : 0.56
  return {
    a: hex(hue, 0.9, l),
    b: hex((hue + 150) % 360, 0.75, l - 0.06),
    c: hex((hue + 320) % 360, 0.8, 0.28),
    dark: hex((hue + 200) % 360, 0.55, minor ? 0.04 : 0.07),
    light: hex((hue + 20) % 360, 0.95, 0.72),
  }
}

const IDLE: VisualFrame = { playing: false, title: '', artist: '', key: null, bpm: null, beatPhase: 0, barBeat: 0, level: 0, trackId: null }

export function Visuals() {
  const [frame, setFrame] = useState<VisualFrame>(IDLE)
  const [scene, setScene] = useState<SceneId | 'auto'>('auto')
  const [autoIndex, setAutoIndex] = useState(0)
  const [hud, setHud] = useState(true)
  const hue = useRef(260)
  const lastTrack = useRef<string | null>(null)
  const [showTitle, setShowTitle] = useState(false)

  useEffect(() => {
    document.title = 'Selector · Visuals'
    const ch = new BroadcastChannel(VISUALS_CHANNEL)
    ch.onmessage = (e) => setFrame(e.data as VisualFrame)
    return () => ch.close()
  }, [])

  // New track on air: show its title for a few seconds; in Auto, move to the next scene.
  useEffect(() => {
    if (!frame.trackId || frame.trackId === lastTrack.current || !frame.playing) return
    if (lastTrack.current) setAutoIndex((i) => (i + 1) % SCENES.length)
    lastTrack.current = frame.trackId
    setShowTitle(true)
    const t = setTimeout(() => setShowTitle(false), 5000)
    return () => clearTimeout(t)
  }, [frame.trackId, frame.playing])

  // Hide the controls when the mouse is still; F for full screen.
  useEffect(() => {
    let t = 0
    const wake = () => {
      setHud(true)
      clearTimeout(t)
      t = window.setTimeout(() => setHud(false), 2500)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'f') void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}))
    }
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', key)
    wake()
    return () => (window.removeEventListener('mousemove', wake), window.removeEventListener('keydown', key))
  }, [])

  // Ease the hue toward the key's colour (~2 s) so key changes glide.
  const target = frame.key ? camelotHue(frame.key) : 260
  const diff = ((target - hue.current + 540) % 360) - 180
  hue.current = (hue.current + diff * 0.03 + 360) % 360
  const minor = frame.key ? parseCamelot(frame.key).letter === 'A' : true
  const p = palette(hue.current, minor)

  const live = frame.playing
  const pulse = live ? Math.exp(-frame.beatPhase * 7) * (frame.barBeat === 0 ? 1 : 0.55) : 0
  const energy = live ? frame.level : 0.15
  const current: SceneId = scene === 'auto' ? SCENES[autoIndex].id : scene

  return (
    <div className="visuals">
      <S.Shader key={current} className="visuals-canvas">
        {current === 'aurora' && (
          <>
            <S.LinearGradient colorA={p.dark} colorB="#000000" angle={90} />
            <S.Aurora colorA={p.a} colorB={p.b} colorC={p.c} intensity={35 + energy * 60} speed={1 + energy * 3} waviness={60 + pulse * 60} curtainCount={3} />
            <S.Bulge strength={pulse * 0.35} radius={1.4} />
            <S.Glow intensity={6 + pulse * 18} threshold={0.35} size={30} />
            <S.FilmGrain strength={0.12} animated />
          </>
        )}
        {current === 'kaleido' && (
          <>
            <S.Plasma colorA={p.a} colorB={p.c} stops={[{ color: p.dark, position: 0 }, { color: p.c, position: 0.35 }, { color: p.a, position: 0.7 }, { color: p.b, position: 1 }]} density={1.8 + energy} speed={0.6 + energy * 1.5} intensity={0.9 + energy * 0.8} contrast={1} balance={50} />
            <S.Kaleidoscope segments={8} angle={(Date.now() / 60) % 360} />
            <S.ChromaticAberration strength={0.05 + pulse * 0.5} />
            <S.Vignette intensity={0.7} radius={0.9} />
          </>
        )}
        {current === 'mesh' && (
          <>
            <S.MeshGradient stops={[{ color: p.dark, position: 0 }, { color: p.c, position: 0.3 }, { color: p.a, position: 0.6 }, { color: p.b, position: 1 }]} colorA={p.a} colorB={p.b} count={5} speed={1 + energy * 4} swirl={0.3 + pulse * 0.5} />
            <S.WaveDistortion strength={0.05 + pulse * 0.25} frequency={3} speed={1 + energy * 2} />
            <S.Glow intensity={3 + energy * 8} threshold={0.65} size={40} />
          </>
        )}
        {current === 'rings' && (
          <>
            <S.Ripples colorA={p.dark} colorB={p.b} frequency={12 + energy * 20} speed={1 + energy * 3} thickness={0.25 + pulse * 0.4} />
            <S.ConcentricSpin intensity={30 + pulse * 60} rings={10} speed={0.6 + energy} />
            <S.ChromaticAberration strength={pulse * 0.4} />
            <S.Glow intensity={4 + pulse * 12} threshold={0.6} size={35} />
          </>
        )}
      </S.Shader>

      <div className={`visuals-title ${showTitle && live ? 'show' : ''}`} aria-live="polite">
        <div className="vt-title">{frame.title}</div>
        <div className="vt-artist">{frame.artist}</div>
      </div>
      {!live && <div className="visuals-idle">Selector · waiting for music</div>}

      <div className={`visuals-hud ${hud ? 'show' : ''}`}>
        {(['auto', ...SCENES.map((s) => s.id)] as const).map((id) => (
          <button key={id} type="button" aria-pressed={scene === id} onClick={() => setScene(id)}>{id === 'auto' ? 'Auto' : SCENES.find((s) => s.id === id)!.name}</button>
        ))}
        <span className="hint">F: full screen</span>
      </div>
    </div>
  )
}
