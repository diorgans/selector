// DJ controller support over Web MIDI (Chrome). Controls are mapped by a learn
// wizard: Selector asks for each control and records the message it sends, so it
// works for Noah's DDJ-SR without guessing Pioneer's message numbers.

import { getMixer, type Deck } from './audio/engine.ts'

// rel: how a relative knob (jog, browse) encodes direction: 'center' = 64 ± n, 'twos' = 1..63 forward / 65..127 back.
export type Binding = { kind: 'note' | 'cc'; channel: number; number: number; invert?: boolean; rel?: 'center' | 'twos' }
export type ActionId = string
export type MidiMap = Record<ActionId, Binding>

export type Step = { id: ActionId; label: string; how: string; kind: 'button' | 'knob' | 'jog' | 'fader-end' | 'encoder' }

const deckSteps = (d: 'A' | 'B', side: string): Step[] => [
  { id: `${d}.play`, label: `${side} deck: PLAY`, how: `Press PLAY/PAUSE on the ${side.toLowerCase()} deck.`, kind: 'button' },
  { id: `${d}.cue`, label: `${side} deck: CUE`, how: `Press CUE on the ${side.toLowerCase()} deck.`, kind: 'button' },
  { id: `${d}.sync`, label: `${side} deck: SYNC`, how: `Press SYNC on the ${side.toLowerCase()} deck.`, kind: 'button' },
  { id: `${d}.jog`, label: `${side} deck: jog wheel`, how: `Turn the ${side.toLowerCase()} jog wheel by its outer edge.`, kind: 'jog' },
  { id: `${d}.tempo`, label: `${side} deck: tempo fader`, how: `Slide the ${side.toLowerCase()} tempo fader all the way to the + end and back to the middle.`, kind: 'fader-end' },
  { id: `${d}.hot1`, label: `${side} deck: pad 1`, how: `Set the ${side.toLowerCase()} pads to HOT CUE and press pad 1.`, kind: 'button' },
  { id: `${d}.hot2`, label: `${side} deck: pad 2`, how: 'Press pad 2.', kind: 'button' },
  { id: `${d}.hot3`, label: `${side} deck: pad 3`, how: 'Press pad 3.', kind: 'button' },
  { id: `${d}.hot4`, label: `${side} deck: pad 4`, how: 'Press pad 4.', kind: 'button' },
  { id: `${d}.high`, label: `${side} channel: HI`, how: `Turn the HI knob on the ${side.toLowerCase()} channel.`, kind: 'knob' },
  { id: `${d}.mid`, label: `${side} channel: MID`, how: `Turn the MID knob on the ${side.toLowerCase()} channel.`, kind: 'knob' },
  { id: `${d}.low`, label: `${side} channel: LOW`, how: `Turn the LOW knob on the ${side.toLowerCase()} channel.`, kind: 'knob' },
  { id: `${d}.filter`, label: `${side} channel: FILTER`, how: `Turn the FILTER knob on the ${side.toLowerCase()} channel.`, kind: 'knob' },
  { id: `${d}.fader`, label: `${side} channel: fader`, how: `Move the ${side.toLowerCase()} channel fader up and down.`, kind: 'knob' },
  { id: `${d}.fx`, label: `${side} deck: FX on`, how: `Press the first FX button (FX 1) for the ${side.toLowerCase()} deck.`, kind: 'button' },
]

export const STEPS: Step[] = [
  ...deckSteps('A', 'Left'),
  ...deckSteps('B', 'Right'),
  { id: 'xfader', label: 'Crossfader', how: 'Move the crossfader from side to side.', kind: 'knob' },
  { id: 'browse', label: 'Browse knob', how: 'Turn the browse knob in the middle a few clicks to the right.', kind: 'encoder' },
  { id: 'A.load', label: 'LOAD left', how: 'Press the LOAD button for the left deck.', kind: 'button' },
  { id: 'B.load', label: 'LOAD right', how: 'Press the LOAD button for the right deck.', kind: 'button' },
]

/** Signed step from a relative knob message (jog wheels, browse knob). */
export function relative(value: number, rel: Binding['rel'] = 'center') {
  if (rel === 'twos') return value < 64 ? value : value - 128
  return value - 64
}

/** Guess a relative knob's encoding from the values it sent while being turned. */
export function detectRel(values: number[]): 'center' | 'twos' {
  return values.some((v) => v >= 56 && v <= 72) ? 'center' : 'twos'
}

// The library hooks the browse knob and LOAD buttons into the track list.
type Browse = { move: (steps: number) => void; load: (deck: 'A' | 'B') => void }
let browse: Browse | undefined
export function setBrowseHandlers(b: Browse) {
  browse = b
}

const KEY = 'selector-midi-map'
export function loadMap(): MidiMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}
export function saveMap(m: MidiMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* private window: works for this visit only */
  }
}

export type Msg = { kind: 'note' | 'cc'; channel: number; number: number; value: number }
export function parse(data: Uint8Array): Msg | null {
  const status = data[0] & 0xf0, channel = data[0] & 0x0f
  if (status === 0x90) return { kind: 'note', channel, number: data[1], value: data[2] }
  if (status === 0x80) return { kind: 'note', channel, number: data[1], value: 0 }
  if (status === 0xb0) return { kind: 'cc', channel, number: data[1], value: data[2] }
  return null
}
export const same = (b: Binding, m: Msg) => b.kind === m.kind && b.channel === m.channel && b.number === m.number

// --- Connection -----------------------------------------------------------------

type Listener = (m: Msg) => void
let access: MIDIAccess | undefined
const listeners = new Set<Listener>()
export let deviceName = ''

/** Ask Chrome for MIDI (one-time permission prompt) and listen to every input. */
export async function connect(): Promise<string> {
  if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI. Use Chrome.')
  access ??= await navigator.requestMIDIAccess({ sysex: false })
  const hook = () => {
    const names: string[] = []
    access!.inputs.forEach((input) => {
      names.push(input.name ?? 'MIDI device')
      input.onmidimessage = (e) => {
        const m = e.data && parse(e.data)
        if (m) listeners.forEach((fn) => fn(m))
      }
    })
    deviceName = names.find((n) => /ddj|pioneer/i.test(n)) ?? names[0] ?? ''
  }
  hook()
  access.onstatechange = hook
  return deviceName
}
export function onMessage(fn: Listener) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Light a controller button (Pioneer lights a button's LED with a note-on to the same note). */
function light(b: Binding | undefined, on: boolean) {
  if (!access || !b || b.kind !== 'note') return
  access.outputs.forEach((out) => {
    if (!/ddj|pioneer/i.test(out.name ?? '') && access!.outputs.size > 1) return
    out.send([0x90 | b.channel, b.number, on ? 0x7f : 0x00])
  })
}

// --- Driving the mixer --------------------------------------------------------------

let started = false
/** Route mapped controller messages to the decks and mixer; keep PLAY lights in sync. */
export function startController() {
  if (started) return
  started = true
  const mixer = getMixer()
  const jogRelease = { A: 0, B: 0 }
  onMessage((m) => {
    const map = loadMap()
    const hit = Object.entries(map).find(([, b]) => same(b, m))
    if (!hit) return
    const [id, b] = hit
    const [d, ctl] = id.includes('.') ? (id.split('.') as ['A' | 'B', string]) : [null, id]
    const v = b.invert ? 127 - m.value : m.value
    if (!d) {
      if (ctl === 'xfader') mixer.setCrossfader(v / 127)
      if (ctl === 'browse') browse?.move(Math.sign(relative(m.value, b.rel)))
      return
    }
    const deck: Deck = mixer.decks[d]
    const other = mixer.decks[d === 'A' ? 'B' : 'A']
    const pressed = m.kind === 'note' && m.value > 0
    switch (ctl) {
      case 'play': if (pressed) deck.toggle(); break
      case 'cue': if (pressed) deck.cue(); break
      case 'sync': if (pressed) deck.syncTo(other); break
      case 'fx': if (pressed) deck.channel.fx.setOn(!deck.channel.fx.on); break
      case 'load': if (pressed) browse?.load(d); break
      case 'hot1': case 'hot2': case 'hot3': case 'hot4': if (pressed) deck.hotCue(Number(ctl.slice(3)) - 1); break
      case 'high': case 'mid': case 'low': deck.channel.setEq(ctl, v / 127); break
      case 'filter': deck.channel.setFilter((v / 127) * 2 - 1); break
      case 'fader': deck.channel.setFader(v / 127); break
      case 'tempo': deck.setRate(1 + ((v / 127) * 2 - 1) * 0.08); break
      case 'jog': {
        // Relative encoder: 64 = still, above = forward, below = back.
        const delta = relative(m.value, b.rel)
        if (deck.state.playing) {
          // Bend the tempo briefly, like pushing a record.
          const release = deck.nudge(Math.max(-0.08, Math.min(0.08, delta * 0.01)))
          clearTimeout(jogRelease[d])
          jogRelease[d] = window.setTimeout(release, 90)
        } else deck.seek(deck.position() + delta * 0.01)
        break
      }
    }
  })
  // PLAY lights follow the decks.
  for (const d of ['A', 'B'] as const) mixer.decks[d].subscribe(() => light(loadMap()[`${d}.play`], mixer.decks[d].state.playing))
}
