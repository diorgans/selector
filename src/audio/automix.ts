// AI automix for music files Noah owns: picks the next track, preloads it on the
// free deck, matches tempo, and blends it in on a phrase boundary. Every move is
// scheduled on the audio clock, so timing stays exact even in a background tab.

import { suggestNext, type Direction } from '../../shared/recommend.ts'
import type { Track } from '../../shared/types.ts'
import { startStems, stemStatus } from '../api.ts'
import { audio, type Deck, type Mixer, type StemGroup } from './engine.ts'
import { pickRecipe, RECIPES, type Recipe, type StyleId } from './recipes.ts'

export type AutomixSettings = { source: 'set' | 'smart'; direction: Direction; style: StyleId | 'surprise'; bars: 8 | 16 | 32; useStems: boolean }

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
  windowBeats: number,
): TransitionPlan {
  if (!out.bpm) {
    // No beatgrid: a plain timed crossfade near the end.
    return { outStart: Math.max(out.position + 1, out.duration - 12), inStart: incoming.firstBeat, inRate: 1, duration: 8, synced: false }
  }
  const beat = 60 / out.bpm // one beat in track time
  const lastBeat = Math.floor((out.duration - out.firstBeat) / beat)
  // Finish the blend ~2 bars before the outgoing track ends, starting on a phrase.
  let startBeat = Math.floor((lastBeat - 8 - windowBeats) / PHRASE_BEATS) * PHRASE_BEATS
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
  return { outStart, inStart: incoming.firstBeat, inRate, duration: (windowBeats * 60) / outBpm, synced }
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
  recipe?: string // name of the transition being used
  history: { track: Track; startedAt: number }[]
}

let instance: Automix | undefined
/** One automix per page, like the mixer. */
export const getAutomix = (...args: ConstructorParameters<typeof Automix>) => (instance ??= new Automix(...args))

export class Automix {
  settings: AutomixSettings = { source: 'smart', direction: 'hold', style: 'surprise', bars: 16, useStems: true }
  private lastStyle?: StyleId
  state: AutomixState = { on: false, status: 'Off', history: [] }
  private timer = 0
  private live: 'A' | 'B' = 'A'
  private prepared?: Track
  private preparing = false
  private scheduled?: { start: number; end: number; plan: TransitionPlan; recipe: Recipe }
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
      for (const g of ['vocals', 'instruments', 'drums'] as StemGroup[]) live.setStemLevel(g, 1)
      this.live = this.other()
      this.scheduled = undefined
      this.prepared = undefined
      const nowLive = this.deck(this.live)
      if (nowLive.state.track) this.state.history.push({ track: nowLive.state.track, startedAt: Date.now() })
      this.emit({ next: undefined, mixAt: undefined, mixEnd: undefined, recipe: undefined, status: `Playing ${nowLive.state.track?.title ?? ''}` })
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
      // Split stems in the background so a stem mashup is possible (live track too).
      if (this.settings.useStems) {
        void this.ensureStems(incoming, next)
        if (live.state.track) void this.ensureStems(live, live.state.track)
      }
    }

    // Schedule the blend ~12 s ahead, once the next track is ready (gives stems time to finish).
    if (this.prepared && !this.scheduled && live.buffer) {
      const lt = live.state.track!
      const recipe = this.chooseRecipe(live, incoming)
      const plan = planTransition(
        { bpm: lt.bpm, firstBeat: lt.firstBeatSec ?? 0, duration: live.duration, rate: live.state.rate, position: live.position() },
        { bpm: this.prepared.bpm, firstBeat: this.prepared.firstBeatSec ?? 0 },
        recipe.beats(this.settings.bars),
      )
      const start = live.timeAt(plan.outStart)
      if (start < now + 0.3) return // too close to schedule cleanly; next tick re-plans
      if (start - now > 12) return this.emit({ mixAt: start, mixEnd: start + plan.duration, status: `Next up: ${this.prepared.title}` })
      this.run(recipe, plan, start, live, incoming)
      this.lastStyle = recipe.id
      this.scheduled = { start, end: start + plan.duration, plan, recipe }
      this.emit({ mixAt: start, mixEnd: start + plan.duration, recipe: recipe.name, status: `${recipe.name} into ${this.prepared.title}` })
    }
  }

  private chooseRecipe(live: Deck, incoming: Deck): Recipe {
    const stemsReady = live.hasStems && incoming.hasStems
    const s = this.settings.style
    if (s === 'surprise') return pickRecipe(this.settings.direction, stemsReady, this.lastStyle)
    if (RECIPES[s].needsStems && !stemsReady) return RECIPES.layer // stems not ready in time: closest feel
    return RECIPES[s]
  }

  /** Schedule every move of a recipe on the audio clock. */
  private run(recipe: Recipe, plan: TransitionPlan, start: number, live: Deck, incoming: Deck) {
    const now = audio().currentTime
    const D = plan.duration
    incoming.setRate(plan.inRate, plan.synced, false)
    incoming.scheduleStart(start, plan.inStart)
    if (live.liveBpm) live.channel.setEchoTime((60 / live.liveBpm) * 0.75) // dotted-eighth echoes
    // Crossfader path: x is "toward the incoming deck", flipped when B is live.
    const toward = (x: number) => (this.live === 'A' ? x : 1 - x)
    this.mixer.scheduleCrossfadePath(recipe.xfade.map((p) => ({ t: start + p.at * D, x: toward(p.x) })))
    for (const m of recipe.moves) {
      const deck = m.deck === 'in' ? incoming : live
      const t = m.at === 0 && m.dur === 0 ? now : start + m.at * D
      const dur = m.dur * D
      if (m.ctl.startsWith('stem:')) {
        if (deck.hasStems) deck.automateStem(m.ctl.slice(5) as StemGroup, m.from, m.to, t, dur)
      } else deck.channel.automate(m.ctl as 'low' | 'mid' | 'high' | 'filter' | 'dry' | 'echo', m.from, m.to, t, dur)
    }
  }

  /** Split a track into stems if needed (in the background), then load them onto its deck. */
  private async ensureStems(deck: Deck, track: Track) {
    if (deck.hasStems || !track.playable) return
    try {
      let st = await stemStatus(track.id)
      if (st.installed === false) return
      if (st.state === 'none' || st.state === 'error') st = await startStems(track.id)
      for (let i = 0; i < 240 && st.state !== 'ready'; i++) {
        if (st.state === 'error' || deck.state.track?.id !== track.id) return
        await new Promise((r) => setTimeout(r, 1000))
        st = await stemStatus(track.id)
      }
      if (st.state === 'ready' && deck.state.track?.id === track.id && !deck.hasStems) await deck.loadStems(track.id)
    } catch {
      /* stems are a bonus; automix works without them */
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
