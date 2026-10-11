import { describe, expect, it, vi } from 'vitest'
vi.mock('../api.ts', () => ({ saveSession: () => Promise.resolve({ ok: true }) }))
import { SessionTracker } from './sessionTracker.ts'

// A fake mixer: two decks with a track, playing flag and fader, plus a crossfader.
function rig() {
  const deck = (id: string, key: string) => ({
    state: { playing: false, track: { id, title: id, artist: 'X', key, playable: true } },
    channel: { knobs: { fader: 1 } },
    liveBpm: 124,
  })
  const mixer = { x: 0, decks: { A: deck('one', '8A'), B: deck('two', '9A') }, crossfaderNow() { return this.x } }
  const tracker = new SessionTracker(mixer as never, { state: { on: true } } as never, false)
  let t = 1_000_000
  const run = (seconds: number) => { for (let i = 0; i < seconds; i++) tracker.tick((t += 1000)) }
  return { mixer, tracker, run }
}

describe('SessionTracker', () => {
  it('logs a track once it has been audible for 20 s', () => {
    const { mixer, tracker, run } = rig()
    mixer.decks.A.state.playing = true
    run(19)
    expect(tracker.current).toBeUndefined()
    run(2)
    expect(tracker.current?.tracks.map((x) => x.trackId)).toEqual(['one'])
  })
  it('counts both tracks during a long layer where neither is ever the loudest', () => {
    const { mixer, tracker, run } = rig()
    mixer.decks.A.state.playing = true
    run(25)
    mixer.decks.B.state.playing = true
    mixer.x = 0.5 // both decks equal for the whole blend
    run(25)
    mixer.decks.A.state.playing = false
    mixer.x = 1
    run(5)
    expect(tracker.current?.tracks.map((x) => x.trackId)).toEqual(['one', 'two'])
  })
  it('ignores a track previewed for a few seconds', () => {
    const { mixer, tracker, run } = rig()
    mixer.decks.A.state.playing = true
    run(30)
    mixer.decks.B.state.playing = true
    mixer.x = 0.5
    run(8)
    mixer.decks.B.state.playing = false
    mixer.x = 0
    run(30)
    expect(tracker.current?.tracks.map((x) => x.trackId)).toEqual(['one'])
  })
  it('does not count a deck with its fader down', () => {
    const { mixer, tracker, run } = rig()
    mixer.decks.A.state.playing = true
    mixer.decks.A.channel.knobs.fader = 0.2
    run(40)
    expect(tracker.current).toBeUndefined()
  })
})
