// The audio engine. Each deck feeds its own channel strip:
//   source(s) → trim → EQ low / mid / high (with kills) → filter → channel fader → crossfader → master
// Positions are tracked from the AudioContext clock, so they stay sample-accurate
// while the UI only redraws ~60 times a second.

import type { Track } from '../../shared/types.ts'
import { computeWaveform, type Waveform } from './waveform.ts'

let ctx: AudioContext | undefined
export function audio(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' })
  return ctx
}

const dbToGain = (db: number) => Math.pow(10, db / 20)

/** EQ knob 0..1 with 0.5 = flat; the bottom of the knob is a full kill. */
export function eqKnobToDb(v: number): number {
  if (v <= 0.02) return -60
  return v < 0.5 ? -26 * (1 - v / 0.5) ** 1.5 : 6 * ((v - 0.5) / 0.5)
}

export class Master {
  readonly input: GainNode
  readonly output: GainNode
  constructor() {
    const c = audio()
    this.input = c.createGain()
    // A gentle limiter on the master bus so two loud decks never clip.
    const limiter = c.createDynamicsCompressor()
    limiter.threshold.value = -1
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.1
    this.output = c.createGain()
    this.input.connect(limiter).connect(this.output).connect(c.destination)
  }
}

class Channel {
  readonly input: GainNode
  readonly low: BiquadFilterNode
  readonly mid: BiquadFilterNode
  readonly high: BiquadFilterNode
  private readonly hp: BiquadFilterNode
  private readonly lp: BiquadFilterNode
  readonly fader: GainNode
  readonly xfade: GainNode
  constructor(master: Master) {
    const c = audio()
    this.input = c.createGain()
    this.low = new BiquadFilterNode(c, { type: 'lowshelf', frequency: 220 })
    this.mid = new BiquadFilterNode(c, { type: 'peaking', frequency: 1000, Q: 0.7 })
    this.high = new BiquadFilterNode(c, { type: 'highshelf', frequency: 3500 })
    this.hp = new BiquadFilterNode(c, { type: 'highpass', frequency: 10, Q: 0.9 })
    this.lp = new BiquadFilterNode(c, { type: 'lowpass', frequency: 22000, Q: 0.9 })
    this.fader = c.createGain()
    this.xfade = c.createGain()
    this.input.connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp).connect(this.fader).connect(this.xfade).connect(master.input)
  }
  setEq(band: 'low' | 'mid' | 'high', knob: number) {
    this[band].gain.setTargetAtTime(eqKnobToDb(knob), audio().currentTime, 0.01)
  }
  /** One knob: left of centre sweeps a low-pass down, right sweeps a high-pass up. */
  setFilter(v: number) {
    const t = audio().currentTime
    const lp = v < -0.02 ? 22000 * Math.pow(200 / 22000, -v) : 22000
    const hp = v > 0.02 ? 10 * Math.pow(4000 / 10, v) : 10
    this.lp.frequency.setTargetAtTime(lp, t, 0.01)
    this.hp.frequency.setTargetAtTime(hp, t, 0.01)
  }
  setFader(v: number) {
    this.fader.gain.setTargetAtTime(v * v, audio().currentTime, 0.01) // squared: feels linear to the ear
  }
}

export type DeckState = {
  track?: Track
  loading: boolean
  error?: string
  playing: boolean
  rate: number // 1 = original speed
  synced: boolean
}

export class Deck {
  readonly channel: Channel
  buffer?: AudioBuffer
  waveform?: Waveform
  state: DeckState = { loading: false, playing: false, rate: 1, synced: false }
  cuePoint = 0
  private sources: AudioBufferSourceNode[] = []
  private startedAt = 0 // context time when playback (re)started
  private startPos = 0 // track position at that moment, in seconds
  private listeners = new Set<() => void>()
  private loadToken = 0

  readonly name: 'A' | 'B'
  constructor(master: Master, name: 'A' | 'B') {
    this.name = name
    this.channel = new Channel(master)
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private emit(patch: Partial<DeckState> = {}) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn())
  }

  get bpm() {
    return this.state.track?.bpm ?? null
  }
  /** Current tempo after the pitch fader. */
  get liveBpm() {
    return this.bpm ? this.bpm * this.state.rate : null
  }
  get duration() {
    return this.buffer?.duration ?? 0
  }

  position(): number {
    if (!this.state.playing) return this.startPos
    return Math.min(this.duration, this.startPos + (audio().currentTime - this.startedAt) * this.state.rate)
  }

  async load(track: Track) {
    const token = ++this.loadToken
    this.stopSources()
    this.startPos = 0
    this.cuePoint = track.cues?.find((c) => c.num === -1)?.timeSec ?? track.firstBeatSec ?? 0
    this.emit({ track, loading: true, error: undefined, playing: false, rate: 1, synced: false })
    try {
      const res = await fetch(`/api/audio?id=${encodeURIComponent(track.id)}`)
      if (!res.ok) throw new Error(res.status === 404 ? 'This track isn’t a playable file.' : `Couldn’t load (${res.status}).`)
      const buffer = await audio().decodeAudioData(await res.arrayBuffer())
      if (token !== this.loadToken) return // another track was loaded meanwhile
      this.buffer = buffer
      this.waveform = computeWaveform(buffer)
      this.startPos = this.cuePoint
      this.emit({ loading: false })
    } catch (err) {
      if (token !== this.loadToken) return
      this.buffer = undefined
      this.waveform = undefined
      this.emit({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private stopSources() {
    for (const s of this.sources) {
      s.onended = null
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.sources = []
  }

  private startSources(at: number) {
    if (!this.buffer) return
    const c = audio()
    const src = new AudioBufferSourceNode(c, { buffer: this.buffer, playbackRate: this.state.rate })
    src.connect(this.channel.input)
    src.onended = () => {
      if (this.sources.includes(src) && this.position() >= this.duration - 0.05) {
        this.startPos = this.duration
        this.sources = []
        this.emit({ playing: false })
      }
    }
    src.start(0, Math.max(0, at))
    this.sources = [src]
    this.startedAt = c.currentTime
    this.startPos = at
  }

  play() {
    if (!this.buffer || this.state.playing) return
    void audio().resume()
    if (this.startPos >= this.duration - 0.05) this.startPos = this.cuePoint
    this.state.playing = true
    this.startSources(this.startPos)
    this.emit({ playing: true })
  }

  pause() {
    if (!this.state.playing) return
    this.startPos = this.position()
    this.stopSources()
    this.emit({ playing: false })
  }

  toggle() {
    if (this.state.playing) this.pause()
    else this.play()
  }

  seek(t: number) {
    const to = Math.max(0, Math.min(this.duration, t))
    if (this.state.playing) {
      this.stopSources()
      this.startSources(to)
    } else this.startPos = to
    this.emit()
  }

  /** CUE: while playing, jump back to the cue point and stop; while stopped, set the cue here. */
  cue() {
    if (this.state.playing) {
      this.pause()
      this.seek(this.cuePoint)
    } else {
      this.cuePoint = this.snapToBeat(this.startPos)
      this.seek(this.cuePoint)
    }
  }

  hotCue(num: number) {
    const cue = this.state.track?.cues?.find((c) => c.num === num)
    if (cue) this.seek(cue.timeSec)
  }

  setRate(rate: number, synced = false) {
    const r = Math.max(0.84, Math.min(1.16, rate)) // ±16%, like a pitch fader on WIDE
    if (this.state.playing) {
      this.startPos = this.position()
      this.startedAt = audio().currentTime
      for (const s of this.sources) s.playbackRate.setValueAtTime(r, audio().currentTime)
    }
    this.emit({ rate: r, synced })
  }

  /** Temporarily speed up or slow down (like pushing a jog wheel) to line up beats by ear. */
  nudge(amount: number) {
    const base = this.state.rate
    this.setRate(base + amount, false)
    return () => this.setRate(base, this.state.synced)
  }

  private beatLength() {
    return this.bpm ? 60 / this.bpm : null
  }

  /** Where we are within the current beat, 0..1 (needs a known BPM). */
  beatPhase(pos = this.position()): number | null {
    const len = this.beatLength()
    if (!len) return null
    const x = (pos - (this.state.track?.firstBeatSec ?? 0)) / len
    return x - Math.floor(x)
  }

  snapToBeat(t: number) {
    const len = this.beatLength()
    if (!len) return t
    const first = this.state.track?.firstBeatSec ?? 0
    return first + Math.round((t - first) / len) * len
  }

  beatJump(beats: number) {
    const len = this.beatLength()
    if (len) this.seek(this.position() + beats * len)
  }

  /** Match the other deck's tempo (allowing half/double time) and line up the beats. */
  syncTo(master: Deck) {
    if (!this.bpm || !master.liveBpm) return false
    const target = master.liveBpm
    const factor = [1, 2, 0.5].reduce((best, f) => (Math.abs((target * f) / this.bpm! - 1) < Math.abs((target * best) / this.bpm! - 1) ? f : best))
    this.setRate((target * factor) / this.bpm, true)
    const theirs = master.beatPhase(), mine = this.beatPhase()
    if (theirs !== null && mine !== null) {
      let delta = theirs - mine
      if (delta > 0.5) delta -= 1
      if (delta < -0.5) delta += 1
      this.seek(this.position() + delta * (60 / this.bpm))
    }
    return true
  }
}

export class Mixer {
  readonly master = new Master()
  readonly decks = { A: new Deck(this.master, 'A'), B: new Deck(this.master, 'B') }
  crossfader = 0.5
  constructor() {
    this.setCrossfader(0.5)
  }
  /** Equal-power curve: the middle is not quieter than either side. */
  setCrossfader(x: number) {
    this.crossfader = Math.max(0, Math.min(1, x))
    const t = audio().currentTime
    this.decks.A.channel.xfade.gain.setTargetAtTime(Math.cos((this.crossfader * Math.PI) / 2), t, 0.005)
    this.decks.B.channel.xfade.gain.setTargetAtTime(Math.sin((this.crossfader * Math.PI) / 2), t, 0.005)
  }
  setMasterVolume(v: number) {
    this.master.output.gain.setTargetAtTime(dbToGain(-24 * (1 - v)) * (v > 0 ? 1 : 0), audio().currentTime, 0.01)
  }
}

let mixer: Mixer | undefined
/** The one mixer, created on first use (browsers only allow audio after a click). */
export const getMixer = () => (mixer ??= new Mixer())
