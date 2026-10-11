// Logs what the crowd actually hears: the deck that's playing with its fader up
// and the crossfader toward it. A track counts once it's been on air for 20 s,
// so quick previews in headphones-style cueing don't end up in the tracklist.

import { defaultSessionName, type Session } from '../../shared/session.ts'
import { saveSession } from '../api.ts'
import type { Automix } from './automix.ts'
import type { Deck, Mixer } from './engine.ts'

const ON_AIR_AFTER_MS = 20_000
const SESSION_GAP_MS = 10 * 60_000 // this long with nothing playing ends the session

let instance: SessionTracker | undefined
/** One tracker per page (React's development double-render must not create two). */
export const getTracker = (mixer: Mixer, automix: Automix) => (instance ??= new SessionTracker(mixer, automix))

export class SessionTracker {
  current?: Session
  private candidate?: { deck: 'A' | 'B'; trackId: string; since: number }
  private onAir?: { deck: 'A' | 'B'; trackId: string }
  private lastSound = 0
  private dirty = false
  private listeners = new Set<() => void>()
  private readonly mixer: Mixer
  private readonly automix: Automix

  constructor(mixer: Mixer, automix: Automix) {
    this.mixer = mixer
    this.automix = automix
    window.setInterval(() => this.tick(), 1000)
    window.setInterval(() => this.flush(), 10_000)
    window.addEventListener('pagehide', () => this.flush())
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private emit() {
    this.listeners.forEach((fn) => fn())
  }

  /** How loud a deck is in the master mix, 0..1. */
  private audibility(name: 'A' | 'B', deck: Deck) {
    if (!deck.state.playing || !deck.state.track) return 0
    const x = this.mixer.crossfaderNow()
    const xf = name === 'A' ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2)
    return xf * deck.channel.knobs.fader ** 2
  }

  tick(now = Date.now()) {
    const levels = (['A', 'B'] as const).map((n) => ({ n, level: this.audibility(n, this.mixer.decks[n]) }))
    const loudest = levels.reduce((a, b) => (b.level > a.level ? b : a))
    if (loudest.level < 0.3) {
      this.candidate = undefined
      if (this.current && now - this.lastSound > SESSION_GAP_MS) this.endSet()
      return
    }
    this.lastSound = now
    const deck = this.mixer.decks[loudest.n]
    const track = deck.state.track!
    if (this.current) {
      this.current.endedAt = now
      const last = this.current.tracks.at(-1)
      if (last && this.onAir?.trackId === track.id && this.onAir.deck === loudest.n) {
        last.playedSec += 1
        this.dirty = true
        return
      }
    }
    if (!this.candidate || this.candidate.trackId !== track.id || this.candidate.deck !== loudest.n) {
      this.candidate = { deck: loudest.n, trackId: track.id, since: now }
      return
    }
    if (now - this.candidate.since < ON_AIR_AFTER_MS) return
    // On air long enough: log it.
    if (!this.current) {
      this.current = { id: `s${this.candidate.since}`, name: defaultSessionName(this.candidate.since), startedAt: this.candidate.since, endedAt: now, tracks: [] }
    }
    this.current.tracks.push({
      trackId: track.id, title: track.title, artist: track.artist,
      bpm: deck.liveBpm ? Math.round(deck.liveBpm * 10) / 10 : null, key: track.key,
      startedAt: this.candidate.since, playedSec: Math.round((now - this.candidate.since) / 1000),
      via: this.automix.state.on ? 'automix' : 'manual',
    })
    this.onAir = { deck: loudest.n, trackId: track.id }
    this.candidate = undefined
    this.dirty = true
    this.emit()
    this.flush()
  }

  rename(name: string) {
    if (!this.current) return
    this.current.name = name
    this.dirty = true
    this.emit()
  }

  /** Close the current session; the next track on air starts a new one. */
  endSet() {
    if (!this.current) return
    this.dirty = true
    this.flush()
    this.current = undefined
    this.onAir = undefined
    this.emit()
  }

  flush() {
    if (!this.dirty || !this.current) return
    this.dirty = false
    void saveSession(this.current).catch(() => (this.dirty = true))
  }
}
