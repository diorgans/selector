// The audio engine. Each deck feeds its own channel strip:
//   source(s) → trim → EQ low / mid / high (with kills) → filter → channel fader → crossfader → master
// Positions are tracked from the AudioContext clock, so they stay sample-accurate
// while the UI only redraws ~60 times a second.

import type { Track } from '../../shared/types.ts'
import { computeWaveform, type Waveform } from './waveform.ts'
import { FxRack } from './fx.ts'
import { detectPhrases, type Phrase } from './phrases.ts'

let ctx: AudioContext | undefined
let stretchReady: Promise<void> | undefined
export function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' })
    // The key-lock time-stretcher runs on the audio thread (public/stretch-worklet.js).
    stretchReady = ctx.audioWorklet.addModule('/stretch-worklet.js')
  }
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
  /** Headphone cue bus: channels with 🎧 on feed this (before their faders). */
  readonly cue: GainNode
  private readonly cueAmt: GainNode
  private readonly masterAmt: GainNode
  private readonly phones: GainNode
  /** Headphones: 0 = only the cued decks, 1 = only the master mix. */
  phonesMix = 0.25
  phonesLevel = 0.8
  /** How many output channels the current sound device has (4 on a DJ controller). */
  outputChannels = 2
  private listeners = new Set<() => void>()
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private changed() {
    this.listeners.forEach((fn) => fn())
  }
  constructor() {
    const c = audio()
    this.input = c.createGain()
    // A gentle limiter on the master bus so two loud decks never clip.
    const limiter = c.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.12
    // Last line of defence: a soft clipper that rounds off anything the limiter
    // lets through, so the output can never pass full scale.
    const clip = new WaveShaperNode(c, { oversample: '2x' })
    const n = 2048, curve = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.abs(x) < 0.85 ? x : Math.sign(x) * (0.85 + 0.15 * Math.tanh((Math.abs(x) - 0.85) / 0.15))
    }
    clip.curve = curve
    this.output = c.createGain()
    this.input.connect(limiter).connect(clip).connect(this.output)

    // Outputs 1-2: master (speakers). Outputs 3-4: headphones (cue blended with master).
    // On a 2-channel device (laptop speakers) only 1-2 exist and the phones mix is dropped.
    const out = new ChannelMergerNode(c, { numberOfInputs: 4 })
    const mSplit = new ChannelSplitterNode(c, { numberOfOutputs: 2 })
    this.output.connect(mSplit)
    mSplit.connect(out, 0, 0)
    mSplit.connect(out, 1, 1)
    this.cue = c.createGain()
    this.cueAmt = c.createGain()
    this.masterAmt = c.createGain()
    this.phones = c.createGain()
    this.cue.connect(this.cueAmt).connect(this.phones)
    this.output.connect(this.masterAmt).connect(this.phones)
    const pSplit = new ChannelSplitterNode(c, { numberOfOutputs: 2 })
    this.phones.connect(pSplit)
    pSplit.connect(out, 0, 2)
    pSplit.connect(out, 1, 3)
    out.connect(c.destination)
    this.configureOutput()
    this.setPhones(this.phonesMix, this.phonesLevel)
  }

  /** Match the output to the device: 4 separate channels when it has them. */
  configureOutput() {
    const d = audio().destination
    this.outputChannels = d.maxChannelCount >= 4 ? 4 : 2
    d.channelCount = this.outputChannels
    d.channelCountMode = 'explicit'
    d.channelInterpretation = 'discrete'
    this.changed()
  }

  setPhones(mix: number, level: number) {
    this.phonesMix = Math.max(0, Math.min(1, mix))
    this.phonesLevel = Math.max(0, Math.min(1, level))
    const t = audio().currentTime
    // Equal-power blend between the cue bus and the master mix.
    this.cueAmt.gain.setTargetAtTime(Math.cos((this.phonesMix * Math.PI) / 2), t, 0.01)
    this.masterAmt.gain.setTargetAtTime(Math.sin((this.phonesMix * Math.PI) / 2), t, 0.01)
    this.phones.gain.setTargetAtTime(this.phonesLevel ** 2, t, 0.01)
    this.changed()
  }
}

/** Send Selector's sound to a specific output device (e.g. the DJ controller). */
export async function setOutputDevice(deviceId: string) {
  const c = audio() as AudioContext & { setSinkId?: (id: string) => Promise<void> }
  if (!c.setSinkId) throw new Error('This browser can’t choose a sound output. Use Chrome.')
  await c.setSinkId(deviceId)
  getMixer().master.configureOutput()
}

export type Knobs = { trim: number; high: number; mid: number; low: number; filter: number; fader: number; cue: number }
const FLAT: Knobs = { trim: 0.5, high: 0.5, mid: 0.5, low: 0.5, filter: 0, fader: 1, cue: 0 }

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
  /** The TRIM knob: all the way down is silent, centre is unchanged, all the way up is +9 dB. */
  private readonly trim: GainNode
  private readonly cueTap: GainNode
  setTrim(knob: number) {
    const gain = knob >= 0.5 ? Math.pow(10, ((knob - 0.5) / 0.5) * 9 / 20) : (knob / 0.5) ** 2
    this.trim.gain.setTargetAtTime(gain, audio().currentTime, 0.01)
    this.changed({ trim: knob })
  }
  /** 🎧: send this channel to the headphones. */
  setCue(on: boolean) {
    this.cueTap.gain.setTargetAtTime(on ? 1 : 0, audio().currentTime, 0.005)
    this.changed({ cue: on ? 1 : 0 })
  }
  /** Dry level after the filter: automix cuts it to let an echo tail ring out on its own. */
  private readonly dry: GainNode
  /** The deck's live effects unit (echo, reverb, phaser, flanger, trans, wah). */
  readonly fx: FxRack
  /** Beat-synced echo: a send into a feedback delay that goes straight to the master. */
  private readonly echoSend: GainNode
  private readonly echoDelay: DelayNode
  constructor(master: Master) {
    const c = audio()
    this.input = c.createGain()
    this.trim = c.createGain()
    this.cueTap = new GainNode(c, { gain: 0 })
    this.low = new BiquadFilterNode(c, { type: 'lowshelf', frequency: 220 })
    this.mid = new BiquadFilterNode(c, { type: 'peaking', frequency: 1000, Q: 0.7 })
    this.high = new BiquadFilterNode(c, { type: 'highshelf', frequency: 3500 })
    this.hp = new BiquadFilterNode(c, { type: 'highpass', frequency: 10, Q: 0.9 })
    this.lp = new BiquadFilterNode(c, { type: 'lowpass', frequency: 22000, Q: 0.9 })
    this.fader = c.createGain()
    this.xfade = c.createGain()
    this.dry = c.createGain()
    this.fx = new FxRack(c)
    this.input.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(this.hp).connect(this.lp).connect(this.fx.input)
    this.fx.output.connect(this.dry).connect(this.fader).connect(this.xfade).connect(master.input)
    // Headphone cue: taken after EQ and effects, before the fader (what DJs call PFL).
    this.fx.output.connect(this.cueTap).connect(master.cue)
    this.echoSend = new GainNode(c, { gain: 0 })
    this.echoDelay = new DelayNode(c, { maxDelayTime: 2, delayTime: 0.36 })
    const feedback = new GainNode(c, { gain: 0.55 })
    const tone = new BiquadFilterNode(c, { type: 'highpass', frequency: 300 }) // echoes thin out instead of muddying the bass
    this.lp.connect(this.echoSend).connect(this.echoDelay).connect(tone).connect(feedback).connect(this.echoDelay)
    tone.connect(master.input)
  }

  /** Echo every `seconds` (automix sets this to a beat or a dotted half-beat). */
  setEchoTime(seconds: number) {
    this.echoDelay.delayTime.setValueAtTime(Math.min(1.9, seconds), audio().currentTime)
  }

  /**
   * Move one control from `from` to `to` over [start, start + dur] on the audio clock.
   * EQ and filter use knob units (EQ 0..1 with 0.5 flat; filter -1..1); dry and echo are 0..1.
   */
  automate(param: 'low' | 'mid' | 'high' | 'filter' | 'dry' | 'echo', from: number, to: number, start: number, dur: number) {
    const end = start + Math.max(0.005, dur)
    const ramp = (p: AudioParam, a: number, b: number, exp = false) => {
      p.setValueAtTime(a, start)
      if (exp) p.exponentialRampToValueAtTime(b, end)
      else p.linearRampToValueAtTime(b, end)
    }
    if (param === 'low' || param === 'mid' || param === 'high') ramp(this[param].gain, eqKnobToDb(from), eqKnobToDb(to))
    else if (param === 'filter') {
      const lpOf = (v: number) => (v < -0.02 ? 22000 * Math.pow(200 / 22000, -v) : 22000)
      const hpOf = (v: number) => (v > 0.02 ? 10 * Math.pow(4000 / 10, v) : 10)
      ramp(this.lp.frequency, lpOf(from), lpOf(to), true)
      ramp(this.hp.frequency, hpOf(from), hpOf(to), true)
    } else if (param === 'dry') ramp(this.dry.gain, from, to)
    else ramp(this.echoSend.gain, from * 0.8, to * 0.8)
    // Let the on-screen knobs follow along.
    if (param === 'low' || param === 'mid' || param === 'high' || param === 'filter') {
      const steps = Math.max(1, Math.min(16, Math.round(dur * 4)))
      for (let i = 0; i <= steps; i++)
        window.setTimeout(() => this.changed({ [param]: from + ((to - from) * i) / steps }), Math.max(0, (start - audio().currentTime + (dur * i) / steps) * 1000))
    }
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
    for (const p of [this.dry.gain, this.echoSend.gain]) p.cancelScheduledValues(t)
    this.dry.gain.setTargetAtTime(1, t, 0.01)
    this.echoSend.gain.setTargetAtTime(0, t, 0.01)
    this.setFilter(0)
    this.setFader(1)
    this.changed({ ...FLAT, trim: this.knobs.trim, cue: this.knobs.cue }) // your trim and 🎧 stay as set
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
  keyLock: boolean // tempo changes keep the original pitch
  stemsLoaded: boolean // playing from separated stems instead of the full mix
  loop: { start: number; end: number } | null // active loop, in track seconds
  loopBeats: number // size for the next auto loop
  stemLevels: Record<StemGroup, number>
}

export class Deck {
  readonly channel: Channel
  buffer?: AudioBuffer
  waveform?: Waveform
  /** 8-bar phrases with names (Intro, Build, Drop…), from the beatgrid and energy. */
  phrases: Phrase[] = []
  state: DeckState = { loading: false, playing: false, rate: 1, synced: false, keyLock: false, stemsLoaded: false, loop: null, loopBeats: 4, stemLevels: { vocals: 1, instruments: 1, drums: 1 } }
  private stems?: Map<StemPart, AudioBuffer>
  /** Key-lock player: one worklet node feeding the full mix or the four stems. */
  private stretch?: { node: AudioWorkletNode; kind: 'full' | 'stems' }
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

  /** Build the key-lock player for whatever is loaded (full mix, or stems if they're on). */
  private buildStretch() {
    this.stretch?.node.disconnect()
    this.stretch = undefined
    if (!this.buffer) return
    const kind = this.stems && this.state.stemsLoaded ? 'stems' : 'full'
    const buffers = kind === 'stems' ? STEM_PARTS.map((p) => this.stems!.get(p)!) : [this.buffer]
    const dests: AudioNode[] = kind === 'stems' ? STEM_PARTS.map((p) => this.stemGains.get(p)!) : [this.channel.input]
    const node = new AudioWorkletNode(audio(), 'stretch-player', { numberOfInputs: 0, numberOfOutputs: buffers.length, outputChannelCount: buffers.map(() => 2) })
    const sources = buffers.map((b) => [b.getChannelData(0).slice(), (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice()])
    node.port.postMessage({ type: 'load', sources }, sources.flat().map((a) => a.buffer))
    dests.forEach((d, i) => node.connect(d, i))
    this.stretch = { node, kind }
  }

  /** Key lock on/off: keep the pitch when changing tempo. Switches seamlessly while playing. */
  async setKeyLock(on: boolean) {
    await stretchReady
    const pos = this.position()
    const pending = this.state.playing && this.startedAt > audio().currentTime ? this.startedAt : undefined
    if (this.state.playing) this.stopSources()
    this.state.keyLock = on
    if (on && this.buffer && !this.stretch) this.buildStretch()
    if (this.state.playing) this.startSources(pending ? this.startPos : pos, pending)
    this.emit({ keyLock: on })
  }

  computePhrases() {
    const t = this.state.track
    this.phrases = this.waveform && t ? detectPhrases(this.waveform, t.firstBeatSec ?? 0, t.bpm, this.duration) : []
  }

  /** Newer info for the loaded song (e.g. analysis just found its BPM and key). */
  refreshTrack(t: Track) {
    const cur = this.state.track
    if (!cur || cur.id !== t.id) return
    let changed = false
    for (const k of ['bpm', 'key', 'firstBeatSec'] as const)
      if ((cur[k] === null || cur[k] === undefined) && t[k] !== null && t[k] !== undefined) {
        Object.assign(cur, { [k]: t[k] })
        changed = true
      }
    if (!changed) return
    if (cur.bpm) this.channel.fx.setBeatSec(60 / (cur.bpm * this.state.rate))
    this.computePhrases()
    this.emit()
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
    const playing = this.state.playing
    // Keep a scheduled (automix) start time if playback hasn't begun yet.
    const pending = playing && this.startedAt > audio().currentTime ? this.startedAt : undefined
    if (playing) this.stopSources()
    this.state.stemsLoaded = true
    if (this.state.keyLock) this.buildStretch()
    if (playing) this.startSources(pending ? this.startPos : pos, pending)
    this.emit({ stemsLoaded: true })
  }

  get hasStems() {
    return this.state.stemsLoaded
  }

  /** Ramp a stem group on the audio clock (automix stem mashups). */
  automateStem(group: StemGroup, from: number, to: number, start: number, dur: number) {
    for (const part of STEM_GROUPS[group]) {
      const g = this.stemGains.get(part)!.gain
      g.setValueAtTime(from * from, start)
      g.linearRampToValueAtTime(to * to, start + Math.max(0.005, dur))
    }
    window.setTimeout(() => this.emit({ stemLevels: { ...this.state.stemLevels, [group]: to } }), Math.max(0, (start + dur - audio().currentTime) * 1000))
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
    const raw = this.startPos + Math.max(0, audio().currentTime - this.startedAt) * this.state.rate
    const loop = this.state.loop
    // Inside a loop the audio wraps from its end back to its start; so does the position.
    if (loop && raw >= loop.end && this.startPos < loop.end) return loop.start + ((raw - loop.start) % (loop.end - loop.start))
    return Math.min(this.duration, raw)
  }

  async load(track: Track) {
    const token = ++this.loadToken
    this.stopSources()
    this.startPos = 0
    this.cuePoint = track.cues?.find((c) => c.num === -1)?.timeSec ?? track.firstBeatSec ?? 0
    this.stems = undefined
    this.phrases = []
    this.stretch?.node.disconnect()
    this.stretch = undefined
    this.lastLoop = null
    this.loopIn = null
    this.emit({ track, loading: true, error: undefined, playing: false, rate: 1, synced: false, stemsLoaded: false, loop: null })
    try {
      const res = await fetch(`/api/audio?id=${encodeURIComponent(track.id)}`)
      if (!res.ok) throw new Error(res.status === 404 ? 'This track isn’t a playable file.' : `Couldn’t load (${res.status}).`)
      const buffer = await audio().decodeAudioData(await res.arrayBuffer())
      if (token !== this.loadToken) return // another track was loaded meanwhile
      this.buffer = buffer
      this.waveform = computeWaveform(buffer)
      if (track.bpm) this.channel.fx.setBeatSec(60 / track.bpm)
      this.computePhrases()
      this.startPos = this.cuePoint
      if (this.state.keyLock) this.buildStretch()
      this.emit({ loading: false })
    } catch (err) {
      if (token !== this.loadToken) return
      this.buffer = undefined
      this.waveform = undefined
      this.emit({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private stopSources() {
    this.stretch?.node.port.postMessage({ type: 'stop' })
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
    if (this.state.keyLock && this.stretch) {
      this.stretch.node.port.postMessage({ type: 'start', when, offset: Math.max(0, at), rate: this.state.rate })
      this.stretch.node.port.onmessage = (e) => {
        if (e.data?.type === 'ended' && this.state.playing && this.position() >= this.duration - 0.1) {
          this.startPos = this.duration
          this.emit({ playing: false })
        }
      }
      this.sources = []
      this.startedAt = when
      this.startPos = at
      return
    }
    const sources = plan.map(([buffer, dest]) => {
      const src = new AudioBufferSourceNode(c, { buffer, playbackRate: this.state.rate })
      src.connect(dest)
      if (this.state.loop) Object.assign(src, { loop: true, loopStart: this.state.loop.start, loopEnd: this.state.loop.end })
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
    // Jumping outside an active loop leaves it.
    const l = this.state.loop
    if (l && (t < l.start || t >= l.end)) {
      this.state.loop = null
      for (const src of this.sources) src.loop = false
      this.stretchLoop()
      this.state = { ...this.state, loop: null }
    }
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

  // --- Loops ------------------------------------------------------------------------
  private lastLoop: { start: number; end: number } | null = null
  private loopIn: number | null = null

  /** Start (or change) a loop. Playback carries on seamlessly; sources wrap natively. */
  setLoop(start: number, end: number) {
    if (!this.buffer || end - start < 0.02) return
    const s = Math.max(0, start), e = Math.min(this.duration, end)
    if (this.state.playing && this.startedAt <= audio().currentTime) {
      // Re-base the clock at the current spot so position maths can wrap from here.
      const pos = this.position()
      this.startPos = pos >= e ? s : pos
      this.startedAt = audio().currentTime
      if (pos >= e) {
        this.state.loop = { start: s, end: e }
        this.stopSources()
        this.startSources(s)
      }
    }
    this.state.loop = { start: s, end: e }
    this.lastLoop = { start: s, end: e }
    for (const src of this.sources) Object.assign(src, { loop: true, loopStart: s, loopEnd: e })
    this.stretchLoop()
    this.emit({ loop: { start: s, end: e } })
  }

  exitLoop() {
    if (!this.state.loop) return
    const pos = this.position()
    if (this.state.playing && this.startedAt <= audio().currentTime) {
      this.startPos = pos
      this.startedAt = audio().currentTime
    }
    this.state.loop = null
    for (const src of this.sources) src.loop = false
    this.stretchLoop()
    this.emit({ loop: null })
  }

  private stretchLoop() {
    const l = this.state.loop
    this.stretch?.node.port.postMessage({ type: 'loop', start: l?.start ?? null, end: l?.end ?? null })
  }

  private beatSec() {
    return this.bpm ? 60 / this.bpm : 0.5
  }

  /** Move the beatgrid: shift beat 1 by `seconds` (± a few ms per click). */
  nudgeGrid(seconds: number) {
    const t = this.state.track
    if (!t || !this.bpm) return
    const beat = 60 / this.bpm
    t.firstBeatSec = (((t.firstBeatSec ?? 0) + seconds) % beat + beat) % beat
    this.computePhrases()
    this.emit()
    return t.firstBeatSec
  }

  /** "The beat is here": put beat 1 of the grid at the playhead (wrapped into the first beat). */
  setGridHere() {
    const t = this.state.track
    if (!t || !this.bpm) return
    const beat = 60 / this.bpm
    t.firstBeatSec = ((this.position() % beat) + beat) % beat
    this.computePhrases()
    this.emit()
    return t.firstBeatSec
  }

  /** AUTO LOOP: loop `beats` from the beat at or just before the playhead; press again to exit. */
  autoLoop(beats = this.state.loopBeats) {
    if (this.state.loop) return this.exitLoop()
    const beat = this.beatSec()
    const first = this.state.track?.firstBeatSec ?? 0
    const pos = this.position()
    const start = this.bpm ? first + Math.floor((pos - first) / beat + 1e-6) * beat : pos
    this.setLoop(start, start + beats * beat)
  }

  /** ½X / 2X: change the loop length (or the size of the next auto loop). */
  resizeLoop(factor: number) {
    const beats = Math.min(32, Math.max(1 / 16, this.state.loopBeats * factor))
    this.state.loopBeats = beats
    const l = this.state.loop
    if (l) this.setLoop(l.start, l.start + beats * this.beatSec())
    else this.emit({ loopBeats: beats })
  }

  /** LOOP IN marks the start; LOOP OUT closes the loop there, rounded to whole beats. */
  setLoopIn() {
    this.loopIn = this.snapToBeat(this.position())
    this.emit()
  }
  setLoopOut() {
    if (this.loopIn === null) return
    const beat = this.beatSec()
    const n = Math.max(1, Math.round((this.position() - this.loopIn) / beat))
    this.state.loopBeats = n
    this.setLoop(this.loopIn, this.loopIn + n * beat)
    this.loopIn = null
  }
  get pendingLoopIn() {
    return this.loopIn
  }

  /** RELOOP / EXIT: leave the loop, or jump back into the last one. */
  reloop() {
    if (this.state.loop) return this.exitLoop()
    if (!this.lastLoop) return
    const { start, end } = this.lastLoop
    this.seek(start)
    this.setLoop(start, end)
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
      this.stretch?.node.port.postMessage({ type: 'rate', rate: r })
    }
    if (this.bpm) this.channel.fx.setBeatSec(60 / (this.bpm * r))
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
    const path = this.xfadePath
    if (path) {
      const t = audio().currentTime
      const i = path.findIndex((p) => p.t >= t)
      if (i === -1) return path.at(-1)!.x
      if (i === 0) return path[0].x
      const a = path[i - 1], b = path[i]
      return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t || 1)
    }
    const k = Math.max(0, Math.min(1, (audio().currentTime - r.start) / r.duration))
    return r.from + (r.to - r.from) * k
  }
  /** Crossfader along a path of (time, position) points, equal-power throughout. */
  scheduleCrossfadePath(points: { t: number; x: number }[]) {
    const pts = [...points].sort((a, b) => a.t - b.t)
    const start = pts[0].t, end = pts.at(-1)!.t
    const n = 256
    const at = (t: number) => {
      const i = pts.findIndex((p) => p.t >= t)
      if (i <= 0) return pts[Math.max(0, i)].x
      const a = pts[i - 1], b = pts[i]
      return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t || 1)
    }
    const xs = Array.from({ length: n }, (_, i) => at(start + ((end - start) * i) / (n - 1)))
    for (const [deck, f] of [[this.decks.A, Math.cos], [this.decks.B, Math.sin]] as const) {
      const g = deck.channel.xfade.gain
      g.cancelScheduledValues(audio().currentTime)
      g.setValueAtTime(f((xs[0] * Math.PI) / 2), audio().currentTime)
      g.setValueCurveAtTime(Float32Array.from(xs, (x) => f((x * Math.PI) / 2)), start, Math.max(0.01, end - start))
    }
    this.xfadePath = pts
    this.xfadeRamp = { from: xs[0], to: xs[n - 1], start, duration: end - start }
    this.listeners.forEach((fn) => fn())
    window.setTimeout(() => {
      if (this.xfadeRamp?.start !== start) return
      this.crossfader = xs[n - 1]
      this.xfadeRamp = undefined
      this.xfadePath = undefined
      this.listeners.forEach((fn) => fn())
    }, Math.max(0, (end - audio().currentTime) * 1000) + 30)
  }
  private xfadePath?: { t: number; x: number }[]

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
    this.xfadePath = undefined
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
    this.setMasterVolume(this.masterVolume)
  }
  /** Equal-power curve: the middle is not quieter than either side. */
  setCrossfader(x: number) {
    this.crossfader = Math.max(0, Math.min(1, x))
    this.xfadeRamp = undefined
    this.xfadePath = undefined
    const t = audio().currentTime
    for (const d of [this.decks.A, this.decks.B]) d.channel.xfade.gain.cancelScheduledValues(t)
    this.listeners?.forEach((fn) => fn())
    this.decks.A.channel.xfade.gain.setTargetAtTime(Math.cos((this.crossfader * Math.PI) / 2), t, 0.005)
    this.decks.B.channel.xfade.gain.setTargetAtTime(Math.sin((this.crossfader * Math.PI) / 2), t, 0.005)
  }
  /** Master volume (0..1): 1 = full level, 0.8 ≈ -5 dB, 0 = silent. Remembered. */
  masterVolume = (() => {
    try {
      const v = Number(localStorage.getItem('selector-master'))
      return v >= 0 && v <= 1 && localStorage.getItem('selector-master') !== null ? v : 0.8
    } catch {
      return 0.8
    }
  })()
  setMasterVolume(v: number) {
    this.masterVolume = Math.max(0, Math.min(1, v))
    this.master.output.gain.setTargetAtTime(this.masterVolume > 0 ? dbToGain(-24 * (1 - this.masterVolume)) : 0, audio().currentTime, 0.01)
    try {
      localStorage.setItem('selector-master', String(this.masterVolume))
    } catch {
      /* this visit only */
    }
    this.listeners.forEach((fn) => fn())
  }
}

let mixer: Mixer | undefined
/** The one mixer, created on first use (browsers only allow audio after a click). */
export const getMixer = () => (mixer ??= new Mixer())
