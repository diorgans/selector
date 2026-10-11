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

export type Knobs = { high: number; mid: number; low: number; filter: number; fader: number }
const FLAT: Knobs = { high: 0.5, mid: 0.5, low: 0.5, filter: 0, fader: 1 }

class Channel {
  /** Where each knob sits, so the UI can show automix moving them. */
  knobs: Knobs = { ...FLAT }
  private listeners = new Set<() => void>()
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private changed(patch: Partial<Knobs>) {
    this.knobs = { ...this.knobs, ...patch }
    this.listeners.forEach((fn) => fn())
  }
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
    this[band].gain.cancelScheduledValues(audio().currentTime)
    this[band].gain.setTargetAtTime(eqKnobToDb(knob), audio().currentTime, 0.01)
    this.changed({ [band]: knob })
  }
  /** Set an EQ band at an exact future moment (used for automix bass swaps). */
  scheduleEq(band: 'low' | 'mid' | 'high', knob: number, at: number) {
    this[band].gain.setTargetAtTime(eqKnobToDb(knob), at, 0.012)
    window.setTimeout(() => this.changed({ [band]: knob }), Math.max(0, (at - audio().currentTime) * 1000))
  }
  /** Sweep the high-pass filter up over a span (automix "filter" transitions). */
  scheduleFilterSweep(to: number, at: number, duration: number) {
    const f = 10 * Math.pow(4000 / 10, to)
    this.hp.frequency.setValueAtTime(10, at)
    this.hp.frequency.exponentialRampToValueAtTime(f, at + duration)
    const steps = 12
    for (let i = 1; i <= steps; i++)
      window.setTimeout(() => (this.knobs = { ...this.knobs, filter: (to * i) / steps }, this.listeners.forEach((fn) => fn())), Math.max(0, (at - audio().currentTime + (duration * i) / steps) * 1000))
  }
  /** Back to flat: EQ centred, filter open, fader up. */
  reset() {
    const t = audio().currentTime
    for (const band of ['low', 'mid', 'high'] as const) {
      this[band].gain.cancelScheduledValues(t)
      this[band].gain.setTargetAtTime(0, t, 0.01)
    }
    this.hp.frequency.cancelScheduledValues(t)
    this.lp.frequency.cancelScheduledValues(t)
    this.setFilter(0)
    this.setFader(1)
    this.changed({ ...FLAT })
  }
  /** One knob: left of centre sweeps a low-pass down, right sweeps a high-pass up. */
  setFilter(v: number) {
    this.changed({ filter: v })
    const t = audio().currentTime
    const lp = v < -0.02 ? 22000 * Math.pow(200 / 22000, -v) : 22000
    const hp = v > 0.02 ? 10 * Math.pow(4000 / 10, v) : 10
    this.lp.frequency.setTargetAtTime(lp, t, 0.01)
    this.hp.frequency.setTargetAtTime(hp, t, 0.01)
  }
  setFader(v: number) {
    this.fader.gain.setTargetAtTime(v * v, audio().currentTime, 0.01) // squared: feels linear to the ear
    this.changed({ fader: v })
  }
}

export const STEM_PARTS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemPart = (typeof STEM_PARTS)[number]
/** What the deck controls show: "Instruments" is bass + other together. */
export const STEM_GROUPS = { vocals: ['vocals'], instruments: ['bass', 'other'], drums: ['drums'] } as const
export type StemGroup = keyof typeof STEM_GROUPS

export type DeckState = {
  track?: Track
  loading: boolean
  error?: string
  playing: boolean
  rate: number // 1 = original speed
  synced: boolean
  stemsLoaded: boolean // playing from separated stems instead of the full mix
  stemLevels: Record<StemGroup, number>
}

export class Deck {
  readonly channel: Channel
  buffer?: AudioBuffer
  waveform?: Waveform
  state: DeckState = { loading: false, playing: false, rate: 1, synced: false, stemsLoaded: false, stemLevels: { vocals: 1, instruments: 1, drums: 1 } }
  private stems?: Map<StemPart, AudioBuffer>
  private stemGains = new Map<StemPart, GainNode>()
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
    for (const part of STEM_PARTS) {
      const g = audio().createGain()
      g.connect(this.channel.input)
      this.stemGains.set(part, g)
    }
  }

  /** Swap playback to separated stems (keeps position; seamless if playing). */
  async loadStems(id: string) {
    const token = this.loadToken
    const buffers = await Promise.all(
      STEM_PARTS.map(async (part) => {
        const res = await fetch(`/api/stem?id=${encodeURIComponent(id)}&part=${part}`)
        if (!res.ok) throw new Error(`Stem ${part} unavailable`)
        return [part, await audio().decodeAudioData(await res.arrayBuffer())] as const
      }),
    )
    if (token !== this.loadToken || this.state.track?.id !== id) return // another track was loaded meanwhile
    this.stems = new Map(buffers)
    const pos = this.position()
    if (this.state.playing) {
      // Keep a scheduled (automix) start time if playback hasn't begun yet.
      const pending = this.startedAt > audio().currentTime ? this.startedAt : undefined
      this.stopSources()
      this.state.stemsLoaded = true
      this.startSources(pos, pending)
    }
    this.emit({ stemsLoaded: true })
  }

  /** Vocals / instruments / drums level, 0–1 (0 mutes that part). */
  setStemLevel(group: StemGroup, level: number) {
    const v = Math.max(0, Math.min(1, level))
    for (const part of STEM_GROUPS[group]) this.stemGains.get(part)!.gain.setTargetAtTime(v * v, audio().currentTime, 0.015)
    this.emit({ stemLevels: { ...this.state.stemLevels, [group]: v } })
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
    // max(0, …): a deck scheduled to start in the future holds at its start point until then.
    return Math.min(this.duration, this.startPos + Math.max(0, audio().currentTime - this.startedAt) * this.state.rate)
  }

  async load(track: Track) {
    const token = ++this.loadToken
    this.stopSources()
    this.startPos = 0
    this.cuePoint = track.cues?.find((c) => c.num === -1)?.timeSec ?? track.firstBeatSec ?? 0
    this.stems = undefined
    this.emit({ track, loading: true, error: undefined, playing: false, rate: 1, synced: false, stemsLoaded: false })
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

  /** Start playing from `at` (seconds into the track) at an exact audio-clock time (automix). */
  scheduleStart(when: number, at: number) {
    if (!this.buffer) return
    void audio().resume()
    this.stopSources()
    this.state.playing = true
    this.startSources(at, when)
    this.emit({ playing: true })
  }

  /** The audio-clock time at which this deck will reach track position `pos` (at the current rate). */
  timeAt(pos: number) {
    return this.startedAt + (pos - this.startPos) / this.state.rate
  }

  private startSources(at: number, startAt?: number) {
    if (!this.buffer) return
    const c = audio()
    // Full mix, or the four stems started at the same instant so they stay sample-aligned.
    const plan: [AudioBuffer, AudioNode][] = this.stems && this.state.stemsLoaded
      ? STEM_PARTS.map((p) => [this.stems!.get(p)!, this.stemGains.get(p)!])
      : [[this.buffer, this.channel.input]]
    const when = startAt ?? c.currentTime
    const sources = plan.map(([buffer, dest]) => {
      const src = new AudioBufferSourceNode(c, { buffer, playbackRate: this.state.rate })
      src.connect(dest)
      src.start(when, Math.max(0, at))
      return src
    })
    sources[0].onended = () => {
      if (this.sources === sources && this.position() >= this.duration - 0.05) {
        this.startPos = this.duration
        this.sources = []
        this.emit({ playing: false })
      }
    }
    this.sources = sources
    this.startedAt = when
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

  /** Bumped on every manual tempo change, so automatic easing can tell it was overridden. */
  tempoTouch = 0
  setRate(rate: number, synced = false, manual = true) {
    if (manual) this.tempoTouch++
    const r = Math.max(0.84, Math.min(1.16, rate)) // ±16%, like a pitch fader on WIDE
    if (this.state.playing) {
      const now = audio().currentTime
      if (this.startedAt <= now) {
        this.startPos = this.position()
        this.startedAt = now
      } // else: a scheduled start hasn't happened yet; position stays at startPos until then
      for (const s of this.sources) s.playbackRate.setValueAtTime(r, now)
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
  /** A crossfade automix has scheduled, so the slider can follow it. */
  xfadeRamp?: { from: number; to: number; start: number; duration: number }
  private listeners = new Set<() => void>()
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  /** Crossfader position right now, including any scheduled ramp. */
  crossfaderNow() {
    const r = this.xfadeRamp
    if (!r) return this.crossfader
    const k = Math.max(0, Math.min(1, (audio().currentTime - r.start) / r.duration))
    return r.from + (r.to - r.from) * k
  }
  /** Move the crossfader from its current spot to `to`, starting at an exact time (equal-power all the way). */
  scheduleCrossfade(to: number, start: number, duration: number) {
    const from = this.crossfaderNow()
    const n = 64
    const curveA = new Float32Array(n), curveB = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = from + ((to - from) * i) / (n - 1)
      curveA[i] = Math.cos((x * Math.PI) / 2)
      curveB[i] = Math.sin((x * Math.PI) / 2)
    }
    for (const [deck, curve] of [[this.decks.A, curveA], [this.decks.B, curveB]] as const) {
      const g = deck.channel.xfade.gain
      g.cancelScheduledValues(audio().currentTime)
      g.setValueAtTime(curve[0], audio().currentTime)
      g.setValueCurveAtTime(curve, start, duration)
    }
    this.xfadeRamp = { from, to, start, duration }
    this.listeners.forEach((fn) => fn())
    window.setTimeout(() => {
      if (this.xfadeRamp?.start !== start) return
      this.crossfader = to
      this.xfadeRamp = undefined
      this.listeners.forEach((fn) => fn())
    }, Math.max(0, (start + duration - audio().currentTime) * 1000) + 30)
  }
  constructor() {
    this.setCrossfader(0.5)
  }
  /** Equal-power curve: the middle is not quieter than either side. */
  setCrossfader(x: number) {
    this.crossfader = Math.max(0, Math.min(1, x))
    this.xfadeRamp = undefined
    const t = audio().currentTime
    for (const d of [this.decks.A, this.decks.B]) d.channel.xfade.gain.cancelScheduledValues(t)
    this.listeners?.forEach((fn) => fn())
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
