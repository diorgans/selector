// Logs what the crowd actually hears: the deck that's playing with its fader up
// and the crossfader toward it. A track counts once it's been on air for 20 s,
// so quick previews in headphones-style cueing don't end up in the tracklist.

import { defaultSessionName, type Session, type SessionTrack } from '../../shared/session.ts'
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
  /** Per deck: the track loaded there and how long it has been clearly audible. */
  private inst: Record<'A' | 'B', { trackId?: string; firstAudible?: number; audibleMs: number; entry?: SessionTrack }> = {
    A: { audibleMs: 0 },
    B: { audibleMs: 0 },
  }
  private lastTick?: number
  private lastSound = 0
  private dirty = false
  private listeners = new Set<() => void>()
  private readonly mixer: Mixer
  private readonly automix: Automix

  constructor(mixer: Mixer, automix: Automix, autostart = true) {
    this.mixer = mixer
    this.automix = automix
    if (!autostart || typeof window === 'undefined') return
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

  // A track counts once it has been clearly audible for 20 s in total, even while
  // sharing the mix with the other deck (long layers and stem mashups do that).
  tick(now = Date.now()) {
    const dt = this.lastTick === undefined ? 0 : Math.min(5000, now - this.lastTick)
    this.lastTick = now
    let anyAudible = false
    for (const name of ['A', 'B'] as const) {
      const deck = this.mixer.decks[name]
      const track = deck.state.track
      const inst = this.inst[name]
      if (track?.id !== inst.trackId) this.inst[name] = { trackId: track?.id, audibleMs: 0 }
      const cur = this.inst[name]
      if (!track || this.audibility(name, deck) < 0.3) continue
      anyAudible = true
      cur.firstAudible ??= now
      cur.audibleMs += dt
      if (cur.entry) {
        cur.entry.playedSec = Math.round(cur.audibleMs / 1000)
        this.dirty = true
      } else if (cur.audibleMs >= ON_AIR_AFTER_MS) {
        this.current ??= { id: `s${cur.firstAudible}`, name: defaultSessionName(cur.firstAudible), startedAt: cur.firstAudible, endedAt: now, tracks: [] }
        cur.entry = {
          trackId: track.id, title: track.title, artist: track.artist,
          bpm: deck.liveBpm ? Math.round(deck.liveBpm * 10) / 10 : null, key: track.key,
          startedAt: cur.firstAudible, playedSec: Math.round(cur.audibleMs / 1000),
          via: this.automix.state.on ? 'automix' : 'manual',
        }
        this.current.tracks.push(cur.entry)
        this.current.tracks.sort((x, y) => x.startedAt - y.startedAt)
        this.current.startedAt = Math.min(this.current.startedAt, cur.firstAudible)
        this.dirty = true
        this.emit()
        this.flush()
      }
    }
    if (anyAudible) {
      this.lastSound = now
      if (this.current) this.current.endedAt = now
    } else if (this.current && now - this.lastSound > SESSION_GAP_MS) this.endSet()
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
    for (const n of ['A', 'B'] as const) this.inst[n] = { trackId: this.inst[n].trackId, audibleMs: 0 }
    this.emit()
  }

  flush() {
    if (!this.dirty || !this.current) return
    this.dirty = false
    void saveSession(this.current).catch(() => (this.dirty = true))
  }
}
