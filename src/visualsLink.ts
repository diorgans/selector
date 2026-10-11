// The main window tells the visuals window what the music is doing, ~30×/s,
// over a BroadcastChannel (same browser, no server). Visuals never touch audio.

import { audio, type Mixer } from './audio/engine.ts'

export const VISUALS_CHANNEL = 'selector-visuals'

export type VisualFrame = {
  playing: boolean
  title: string
  artist: string
  key: string | null
  bpm: number | null
  beatPhase: number // 0..1 within the current beat (0 = on the beat)
  barBeat: number // 0..3: which beat of the bar
  level: number // 0..1, smoothed loudness of the master
  trackId: string | null
}

let started = false
const local = new Set<(f: VisualFrame) => void>()

/** Frames inside this window (for visuals drawn behind the player). */
export function onVisualFrame(fn: (f: VisualFrame) => void) {
  local.add(fn)
  return () => void local.delete(fn)
}

/** Start broadcasting (idempotent). Cheap: one analyser read and one message per frame. */
export function startVisualsLink(mixer: Mixer) {
  if (started) return
  started = true
  const ch = new BroadcastChannel(VISUALS_CHANNEL)
  const an = audio().createAnalyser()
  an.fftSize = 1024
  mixer.master.output.connect(an)
  const buf = new Float32Array(an.fftSize)
  let level = 0
  window.setInterval(() => {
    an.getFloatTimeDomainData(buf)
    let sum = 0
    for (const x of buf) sum += x * x
    const rms = Math.sqrt(sum / buf.length)
    // Fast attack, slower release, scaled so a loud club master sits near 1.
    const target = Math.min(1, rms * 3.2)
    level += (target - level) * (target > level ? 0.6 : 0.12)

    // The deck the crowd hears: playing, fader up, crossfader toward it.
    const x = mixer.crossfaderNow()
    const loud = (['A', 'B'] as const)
      .map((n) => {
        const d = mixer.decks[n]
        const xf = n === 'A' ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2)
        return { d, v: d.state.playing ? xf * d.channel.knobs.fader ** 2 : 0 }
      })
      .reduce((a, b) => (b.v > a.v ? b : a))
    const d = loud.d
    const t = d.state.track
    const phase = d.beatPhase() ?? 0
    const beatsIn = d.bpm ? (d.position() - (t?.firstBeatSec ?? 0)) / (60 / d.bpm) : 0
    const frame: VisualFrame = {
      playing: loud.v > 0.05,
      title: t?.title ?? '',
      artist: t?.artist ?? '',
      key: t?.key ?? null,
      bpm: d.liveBpm,
      beatPhase: phase,
      barBeat: ((Math.floor(beatsIn) % 4) + 4) % 4,
      level,
      trackId: t?.id ?? null,
    }
    ch.postMessage(frame)
    local.forEach((fn) => fn(frame))
  }, 33)
}

export function openVisuals() {
  window.open(`${location.pathname}#visuals`, 'selector-visuals', 'popup,width=1280,height=720')
}
