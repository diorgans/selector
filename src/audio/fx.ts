// A per-deck effects unit, like the beat FX on a DDJ controller: pick an effect,
// a beat length, and an amount; tempo-synced effects follow the deck's BPM.
//
//   input ──┬─ dry ─────────────────────────────┬── output
//           └─ send ── [effect] ── wet[effect] ─┘
// Every effect is built once and fed by `send`; only the chosen one's wet level is up.

export type FxType = 'echo' | 'reverb' | 'phaser' | 'flanger' | 'trans' | 'wah'

export const FX_INFO: Record<FxType, { name: string; synced: boolean; hint: string }> = {
  echo: { name: 'Echo', synced: true, hint: 'Repeats on the beat; the tail rings out when you turn it off' },
  reverb: { name: 'Reverb', synced: false, hint: 'Puts the track in a big room' },
  phaser: { name: 'Phaser', synced: true, hint: 'A swirling, sweeping tone' },
  flanger: { name: 'Flanger', synced: true, hint: 'A jet-plane whoosh' },
  trans: { name: 'Trans', synced: true, hint: 'Chops the sound on and off in time' },
  wah: { name: 'Wah', synced: true, hint: 'A filter that sweeps up and down in time' },
}

export const BEAT_CHOICES = [0.25, 0.5, 0.75, 1, 2, 4] as const

/** A short reverb tail made of decaying noise (no samples needed). */
function impulse(ctx: BaseAudioContext, seconds = 2.6, decay = 3.2) {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay)
  }
  return buf
}

export class FxUnit {
  readonly input: GainNode
  readonly output: GainNode
  type: FxType = 'echo'
  on = false
  amount = 0.5
  beats = 1
  private beatSec = 0.5
  private readonly ctx: BaseAudioContext
  private readonly dry: GainNode
  private readonly send: GainNode
  private readonly wet: Record<FxType, GainNode>
  private readonly echoDelay: DelayNode
  private readonly echoFeedback: GainNode
  private readonly lfos: { osc: OscillatorNode; type: FxType }[] = []
  /** Where `send` plugs into each effect; only the chosen one is connected (saves CPU). */
  private readonly entry: Partial<Record<FxType, AudioNode>> = {}
  private releaseTimer = 0
  private listeners = new Set<() => void>()
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private changed() {
    this.listeners.forEach((fn) => fn())
  }

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.dry = ctx.createGain()
    this.send = new GainNode(ctx, { gain: 0 })
    this.input.connect(this.dry).connect(this.output)
    this.input.connect(this.send)
    // `send` is wired to one effect at a time in route().
    const wet = () => new GainNode(ctx, { gain: 0 })
    this.wet = { echo: wet(), reverb: wet(), phaser: wet(), flanger: wet(), trans: wet(), wah: wet() }
    for (const g of Object.values(this.wet)) g.connect(this.output)

    // Echo: feedback delay, darkened a little each repeat.
    this.echoDelay = new DelayNode(ctx, { maxDelayTime: 4, delayTime: 0.5 })
    this.echoFeedback = new GainNode(ctx, { gain: 0.5 })
    const echoTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000 })
    this.entry.echo = this.echoDelay
    this.echoDelay.connect(echoTone).connect(this.echoFeedback).connect(this.echoDelay)
    echoTone.connect(this.wet.echo)

    // Reverb.
    const conv = new ConvolverNode(ctx, { buffer: impulse(ctx) })
    this.entry.reverb = conv
    conv.connect(this.wet.reverb)

    // Phaser: six all-pass stages swept by one LFO.
    let node: AudioNode | undefined
    const phLfo = this.lfo('phaser', 'sine', 1100)
    for (let i = 0; i < 8; i++) {
      const ap = new BiquadFilterNode(ctx, { type: 'allpass', frequency: 1300, Q: 0.8 })
      phLfo.connect(ap.frequency)
      if (node) node.connect(ap)
      else this.entry.phaser = ap
      node = ap
    }
    node!.connect(this.wet.phaser)

    // Flanger: a tiny modulated delay with feedback.
    const fl = new DelayNode(ctx, { maxDelayTime: 0.02, delayTime: 0.004 })
    const flFb = new GainNode(ctx, { gain: 0.75 })
    this.lfo('flanger', 'sine', 0.0035).connect(fl.delayTime)
    this.entry.flanger = fl
    fl.connect(flFb).connect(fl)
    fl.connect(this.wet.flanger)

    // Trans: a square-wave gate.
    const gate = new GainNode(ctx, { gain: 0.5 })
    this.lfo('trans', 'square', 0.5).connect(gate.gain)
    this.entry.trans = gate
    gate.connect(this.wet.trans)

    // Wah: a resonant band-pass swept in time.
    const wah = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1200, Q: 5 })
    this.lfo('wah', 'sine', 900).connect(wah.frequency)
    const wahBoost = new GainNode(ctx, { gain: 2.2 })
    this.entry.wah = wah
    wah.connect(wahBoost).connect(this.wet.wah)

    this.route()
    this.retime()
  }

  /** An LFO whose output (±depth) is added to whatever it's connected to. */
  private lfo(type: FxType, wave: OscillatorType, depth: number) {
    const osc = new OscillatorNode(this.ctx, { type: wave, frequency: 1 })
    const amp = new GainNode(this.ctx, { gain: depth })
    osc.connect(amp)
    osc.start()
    this.lfos.push({ osc, type })
    return amp
  }

  /** The deck's current beat length in seconds (call when tempo changes). */
  setBeatSec(sec: number) {
    if (!(sec > 0)) return
    this.beatSec = sec
    this.retime()
  }
  setBeats(b: number) {
    this.beats = b
    this.retime()
    this.changed()
  }
  private retime() {
    const t = this.ctx.currentTime
    const period = this.beats * this.beatSec
    this.echoDelay.delayTime.setTargetAtTime(Math.min(3.9, period), t, 0.02)
    for (const { osc, type } of this.lfos) {
      // Trans chops once per period; sweeping effects take two periods per cycle so they feel slower.
      const cycle = type === 'trans' ? period : period * 2
      osc.frequency.setTargetAtTime(1 / cycle, t, 0.02)
    }
  }

  /** Plug `send` into the chosen effect only. */
  private route() {
    try {
      this.send.disconnect()
    } catch {
      /* not connected yet */
    }
    this.send.connect(this.entry[this.type]!)
  }

  setType(type: FxType) {
    if (type === this.type) return
    const wasOn = this.on
    if (wasOn) this.setOn(false, true)
    this.type = type
    this.route()
    if (wasOn) this.setOn(true)
    this.changed()
  }
  setAmount(v: number) {
    this.amount = Math.max(0, Math.min(1, v))
    if (this.on) this.apply()
    this.changed()
  }

  setOn(on: boolean, instant = false) {
    this.on = on
    window.clearTimeout(this.releaseTimer)
    const t = this.ctx.currentTime
    this.changed()
    if (on) return this.apply()
    // Off: stop feeding the effect. Echo and reverb tails ring out, then close.
    this.send.gain.setTargetAtTime(0, t, 0.01)
    this.dry.gain.setTargetAtTime(1, t, 0.01)
    const tail = !instant && (this.type === 'echo' || this.type === 'reverb')
    if (tail) this.releaseTimer = window.setTimeout(() => this.wet[this.type].gain.setTargetAtTime(0, this.ctx.currentTime, 0.2), 4000)
    else for (const g of Object.values(this.wet)) g.gain.setTargetAtTime(0, t, 0.01)
  }

  private apply() {
    const t = this.ctx.currentTime, a = this.amount
    for (const [k, g] of Object.entries(this.wet)) if (k !== this.type) g.gain.setTargetAtTime(0, t, 0.02)
    // "Send" effects (echo, reverb) add on top of the dry sound; "insert" effects blend with it.
    const insert = this.type !== 'echo' && this.type !== 'reverb'
    // Phaser and flanger need dry and wet near equal to carve deep, moving notches.
    const wetLevel = { echo: a * 0.7, reverb: a * 1.1, phaser: a * 0.75, flanger: a * 0.7, trans: 1, wah: a }[this.type]
    const dryLevel = this.type === 'phaser' || this.type === 'flanger' ? 1 - 0.25 * a : insert ? 1 - 0.5 * a : this.type === 'reverb' ? 1 - 0.25 * a : 1
    if (this.type === 'trans') {
      // Gate depth: the "amount" decides how much of the off-beat survives.
      this.send.gain.setTargetAtTime(1, t, 0.01)
      this.dry.gain.setTargetAtTime(1 - a, t, 0.01)
      this.wet.trans.gain.setTargetAtTime(a, t, 0.01)
      return
    }
    this.echoFeedback.gain.setTargetAtTime(0.3 + 0.4 * a, t, 0.02)
    this.send.gain.setTargetAtTime(1, t, 0.01)
    this.dry.gain.setTargetAtTime(dryLevel, t, 0.02)
    this.wet[this.type].gain.setTargetAtTime(wetLevel, t, 0.02)
  }
}

/**
 * Three effect slots per deck, chained, like the DDJ-SR's FX section: each slot has
 * its own effect, on/off button and level knob; the beat length is shared.
 */
export class FxRack {
  readonly slots: FxUnit[]
  readonly input: AudioNode
  readonly output: AudioNode
  beats = 1
  private listeners = new Set<() => void>()
  constructor(ctx: BaseAudioContext) {
    this.slots = [new FxUnit(ctx), new FxUnit(ctx), new FxUnit(ctx)]
    this.slots[1].setType('reverb')
    this.slots[2].setType('flanger')
    this.slots[0].output.connect(this.slots[1].input)
    this.slots[1].output.connect(this.slots[2].input)
    this.input = this.slots[0].input
    this.output = this.slots[2].output
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn)
    const offs = this.slots.map((s) => s.subscribe(fn))
    return () => {
      this.listeners.delete(fn)
      offs.forEach((off) => off())
    }
  }
  setBeatSec(sec: number) {
    for (const s of this.slots) s.setBeatSec(sec)
  }
  setBeats(b: number) {
    this.beats = b
    for (const s of this.slots) s.setBeats(b)
    this.listeners.forEach((fn) => fn())
  }
  /** The BEATS knob: step the beat length of the effects that are on (all three if none are). */
  stepBeats(dir: number) {
    const targets = this.slots.some((s) => s.on) ? this.slots.filter((s) => s.on) : this.slots
    for (const s of targets) {
      const i = BEAT_CHOICES.indexOf(s.beats as (typeof BEAT_CHOICES)[number])
      s.setBeats(BEAT_CHOICES[Math.max(0, Math.min(BEAT_CHOICES.length - 1, (i < 0 ? BEAT_CHOICES.indexOf(1) : i) + Math.sign(dir)))])
    }
    this.listeners.forEach((fn) => fn())
  }
}
