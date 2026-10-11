// AI automix for music files Noah owns: picks the next track, preloads it on the
// free deck, matches tempo, and blends it in on a phrase boundary. Every move is
// scheduled on the audio clock, so timing stays exact even in a background tab.

import { suggestNext, type Direction } from '../../shared/recommend.ts'
import type { Track } from '../../shared/types.ts'
import { audio, type Deck, type Mixer } from './engine.ts'

export type Style = 'blend' | 'filter' | 'cut'
export type AutomixSettings = { source: 'set' | 'smart'; direction: Direction; style: Style; bars: 8 | 16 | 32 }

// --- Planning (pure maths, unit-tested) --------------------------------------

export type TransitionPlan = {
  outStart: number // position in the outgoing track where the mix starts (seconds)
  inStart: number // position in the incoming track to start from (its first downbeat)
  inRate: number // incoming playback rate so tempos match
  duration: number // length of the blend in real seconds
  synced: boolean
}

const PHRASE_BEATS = 32 // 8 bars: dance music changes section on these boundaries

export function planTransition(
  out: { bpm: number | null; firstBeat: number; duration: number; rate: number; position: number },
  incoming: { bpm: number | null; firstBeat: number },
  bars: number,
  style: Style,
): TransitionPlan {
  const lengthBeats = style === 'cut' ? 4 : bars * 4
  if (!out.bpm) {
    // No beatgrid: a plain timed crossfade near the end.
    const duration = style === 'cut' ? 0.05 : 8
    return { outStart: Math.max(out.position + 1, out.duration - duration - 4), inStart: incoming.firstBeat, inRate: 1, duration, synced: false }
  }
  const beat = 60 / out.bpm // one beat in track time
  const lastBeat = Math.floor((out.duration - out.firstBeat) / beat)
  // Finish the blend ~2 bars before the outgoing track ends, starting on a phrase.
  let startBeat = Math.floor((lastBeat - 8 - lengthBeats) / PHRASE_BEATS) * PHRASE_BEATS
  const nowBeat = (out.position - out.firstBeat) / beat
  // Too late for that phrase? Use the next bar instead.
  if (startBeat < nowBeat + 8) startBeat = Math.ceil((nowBeat + 8) / 4) * 4
  const outStart = out.firstBeat + startBeat * beat
  const outBpm = out.bpm * out.rate
  let inRate = 1, synced = false
  if (incoming.bpm) {
    const factor = [1, 2, 0.5].reduce((best, f) => (Math.abs((outBpm * f) / incoming.bpm! - 1) < Math.abs((outBpm * best) / incoming.bpm! - 1) ? f : best))
    const r = (outBpm * factor) / incoming.bpm
    if (Math.abs(r - 1) <= 0.16) (inRate = r), (synced = true)
  }
  const duration = style === 'cut' ? 0.05 : (lengthBeats * 60) / outBpm
  return { outStart, inStart: incoming.firstBeat, inRate, duration, synced }
}

/** The next track: the set's order, or the best "Up next" suggestion. */
export function pickNext(current: Track, pool: Track[], played: Set<string>, settings: AutomixSettings, set: string[]): Track | undefined {
  const usable = pool.filter((t) => t.playable && !played.has(t.id) && t.id !== current.id)
  if (settings.source === 'set') {
    const at = set.indexOf(current.id)
    const rest = [...set.slice(at + 1), ...set.slice(0, Math.max(0, at))]
    return rest.map((id) => usable.find((t) => t.id === id)).find((t): t is Track => !!t)
  }
  return suggestNext(current, usable, { direction: settings.direction, limit: 1 })[0]?.track ?? usable.find((t) => t.bpm)
}

// --- Running it ----------------------------------------------------------------

export type AutomixState = {
  on: boolean
  status: string
  next?: Track
  mixAt?: number // audio-clock time the next blend starts
  mixEnd?: number // and when it finishes
  history: { track: Track; startedAt: number }[]
}

let instance: Automix | undefined
/** One automix per page, like the mixer. */
export const getAutomix = (...args: ConstructorParameters<typeof Automix>) => (instance ??= new Automix(...args))

export class Automix {
  settings: AutomixSettings = { source: 'smart', direction: 'hold', style: 'blend', bars: 16 }
  state: AutomixState = { on: false, status: 'Off', history: [] }
  private timer = 0
  private live: 'A' | 'B' = 'A'
  private prepared?: Track
  private preparing = false
  private scheduled?: { start: number; end: number; plan: TransitionPlan }
  private listeners = new Set<() => void>()
  private readonly mixer: Mixer
  private readonly source: { pool: () => Track[]; set: () => string[]; first: () => Track | undefined }

  constructor(mixer: Mixer, source: { pool: () => Track[]; set: () => string[]; first: () => Track | undefined }) {
    this.mixer = mixer
    this.source = source
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private emit(patch: Partial<AutomixState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn())
  }
  private deck(name: 'A' | 'B'): Deck {
    return this.mixer.decks[name]
  }
  private other(): 'A' | 'B' {
    return this.live === 'A' ? 'B' : 'A'
  }
  configure(patch: Partial<AutomixSettings>) {
    this.settings = { ...this.settings, ...patch }
    // A blend that hasn't started yet is re-planned with the new settings.
    if (this.scheduled && audio().currentTime < this.scheduled.start - 0.5) this.unschedule()
    this.emit({})
  }

  async start() {
    if (this.state.on) return
    const { A, B } = this.mixer.decks
    // Continue from whatever is playing; otherwise start the first track on deck A.
    if (A.state.playing || B.state.playing) {
      this.live = A.state.playing && (!B.state.playing || this.mixer.crossfader <= 0.5) ? 'A' : 'B'
    } else {
      const first = this.source.first()
      if (!first) return this.emit({ status: 'Pick a playable track first (or add some to your set).' })
      this.live = 'A'
      this.emit({ status: `Loading ${first.title}…` })
      await A.load(first)
      if (!A.buffer) return this.emit({ status: A.state.error ?? 'Couldn’t load the first track.' })
      A.seek(first.firstBeatSec ?? 0)
      A.play()
    }
    this.mixer.setCrossfader(this.live === 'A' ? 0 : 1)
    const liveTrack = this.deck(this.live).state.track
    this.emit({ on: true, status: 'Listening…', history: liveTrack ? [{ track: liveTrack, startedAt: Date.now() }] : [] })
    this.timer = window.setInterval(() => void this.tick(), 400)
    void this.tick()
  }

  stop() {
    window.clearInterval(this.timer)
    this.unschedule()
    this.prepared = undefined
    this.emit({ on: false, status: 'Off', next: undefined, mixAt: undefined })
  }

  /** Cancel a blend that hasn't begun: stop the waiting deck and put the crossfader back. */
  private unschedule() {
    if (!this.scheduled) return
    const now = audio().currentTime
    if (now < this.scheduled.start) {
      const waiting = this.deck(this.other())
      waiting.pause()
      waiting.seek(this.scheduled.plan.inStart)
      waiting.channel.reset()
      this.deck(this.live).channel.reset()
      this.mixer.setCrossfader(this.live === 'A' ? 0 : 1)
    }
    this.scheduled = undefined
    this.emit({ mixAt: undefined })
  }

  private async tick() {
    if (!this.state.on) return
    const now = audio().currentTime
    const live = this.deck(this.live)
    const incoming = this.deck(this.other())

    // A blend just finished: the incoming deck is now live.
    if (this.scheduled && now > this.scheduled.end + 0.15) {
      live.pause()
      live.channel.reset()
      this.live = this.other()
      this.scheduled = undefined
      this.prepared = undefined
      const nowLive = this.deck(this.live)
      if (nowLive.state.track) this.state.history.push({ track: nowLive.state.track, startedAt: Date.now() })
      this.emit({ next: undefined, mixAt: undefined, mixEnd: undefined, status: `Playing ${nowLive.state.track?.title ?? ''}` })
      this.easeTempoHome(nowLive)
      return
    }
    if (!live.state.playing && !this.scheduled) return this.stop() // someone stopped the music

    // Preload the next track on the free deck.
    if (!this.prepared && !this.preparing && live.state.track) {
      const played = new Set(this.state.history.map((h) => h.track.id))
      const next = pickNext(live.state.track, this.source.pool(), played, this.settings, this.source.set())
      if (!next) return this.emit({ status: 'Out of tracks that mix well. Automix will stop after this one.' })
      this.preparing = true
      this.emit({ next, status: `Next up: ${next.title}` })
      await incoming.load(next)
      this.preparing = false
      if (!this.state.on) return
      if (!incoming.buffer) return this.emit({ status: `Couldn’t load ${next.title}; trying another…` })
      incoming.channel.reset()
      this.prepared = next
    }

    // Schedule the blend once the next track is ready.
    if (this.prepared && !this.scheduled && live.buffer) {
      const lt = live.state.track!
      const plan = planTransition(
        { bpm: lt.bpm, firstBeat: lt.firstBeatSec ?? 0, duration: live.duration, rate: live.state.rate, position: live.position() },
        { bpm: this.prepared.bpm, firstBeat: this.prepared.firstBeatSec ?? 0 },
        this.settings.bars,
        this.settings.style,
      )
      const start = live.timeAt(plan.outStart)
      if (start < now + 0.3) return // too close to schedule cleanly; next tick re-plans
      incoming.setRate(plan.inRate, plan.synced, false)
      incoming.scheduleStart(start, plan.inStart)
      const to = this.live === 'A' ? 1 : 0
      const { style } = this.settings
      if (style === 'cut') {
        this.mixer.scheduleCrossfade(to, start, 0.03)
      } else {
        this.mixer.scheduleCrossfade(to, start, plan.duration)
        if (style === 'blend') {
          // Bass swap: never two basslines at once.
          incoming.channel.scheduleEq('low', 0, now)
          live.channel.scheduleEq('low', 0, start + plan.duration / 2)
          incoming.channel.scheduleEq('low', 0.5, start + plan.duration / 2)
        } else {
          live.channel.scheduleFilterSweep(0.85, start, plan.duration)
        }
      }
      this.scheduled = { start, end: start + plan.duration, plan }
      this.emit({ mixAt: start, mixEnd: start + plan.duration, status: `${style === 'cut' ? 'Cutting' : 'Mixing'} into ${this.prepared.title}` })
    }
  }

  /** After a blend, drift the new track back to its own tempo over a few seconds. */
  private easeTempoHome(deck: Deck) {
    const from = deck.state.rate
    if (Math.abs(from - 1) < 0.002) return
    const steps = 16
    const touch = deck.tempoTouch // a manual change (slider, typed BPM, Reset) stops the easing
    for (let i = 1; i <= steps; i++)
      window.setTimeout(() => {
        if (deck.state.track && this.state.on && !this.scheduled && deck.tempoTouch === touch) deck.setRate(from + ((1 - from) * i) / steps, false, false)
      }, i * 500)
  }
}
