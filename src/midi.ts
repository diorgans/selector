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
  { id: `${d}.keylock`, label: `${side} deck: KEY LOCK`, how: `Press KEY LOCK on the ${side.toLowerCase()} deck (near its tempo fader).`, kind: 'button' },
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
  { id: `${d}.loopauto`, label: `${side} deck: AUTO LOOP`, how: `Press AUTO LOOP on the ${side.toLowerCase()} deck.`, kind: 'button' },
  { id: `${d}.loophalf`, label: `${side} deck: LOOP ½X`, how: 'Press the 1/2X loop button.', kind: 'button' },
  { id: `${d}.loopdouble`, label: `${side} deck: LOOP 2X`, how: 'Press the 2X loop button.', kind: 'button' },
  { id: `${d}.loopin`, label: `${side} deck: LOOP IN`, how: 'Press LOOP IN.', kind: 'button' },
  { id: `${d}.loopout`, label: `${side} deck: LOOP OUT`, how: 'Press LOOP OUT.', kind: 'button' },
  { id: `${d}.reloop`, label: `${side} deck: RELOOP/EXIT`, how: 'Press RELOOP/EXIT.', kind: 'button' },
  ...[1, 2, 3].flatMap((n): Step[] => [
    { id: `${d}.fx${n}`, label: `${side} FX ${n}: on/off`, how: `Press FX button ${n} on the ${side.toLowerCase()} side.`, kind: 'button' },
    { id: `${d}.fx${n}lvl`, label: `${side} FX ${n}: level`, how: `Turn the FX ${n} knob above it.`, kind: 'knob' },
  ]),
  { id: `${d}.fxbeats`, label: `${side} FX: beats`, how: `Turn the FX BEATS knob on the ${side.toLowerCase()} side a few clicks (skip if yours has none).`, kind: 'encoder' },
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
    const raw: MidiMap = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    // Drop controls that no longer exist (e.g. the old single "FX on"), so they can't
    // swallow a button that is now mapped to something else.
    const known = new Set(STEPS.map((s) => s.id))
    return Object.fromEntries(Object.entries(raw).filter(([id]) => known.has(id)))
  } catch {
    return {}
  }
}

/** What the last controller message did, for the setup window. */
export let lastAction = ''
const actionListeners = new Set<(s: string) => void>()
export function onAction(fn: (s: string) => void) {
  actionListeners.add(fn)
  return () => void actionListeners.delete(fn)
}
function report(s: string) {
  lastAction = s
  actionListeners.forEach((fn) => fn(s))
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
let lastSig = ''
let lastAt = 0
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
        if (!m) return
        // Some setups deliver the same message twice (two ports for one device); a
        // doubled press would switch a toggle on and straight back off.
        const sig = `${m.kind}${m.channel}:${m.number}:${m.value}`
        const now = performance.now()
        if (m.kind === 'note' && sig === lastSig && now - lastAt < 15) return
        lastSig = sig
        lastAt = now
        listeners.forEach((fn) => fn(m))
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
    if (!hit) {
      if (m.kind === 'note' && m.value > 0) report(`button #${m.number} (ch ${m.channel + 1}): no control mapped to it`)
      return
    }
    const [id, b] = hit
    if (m.kind === 'note' && m.value > 0) report(`${STEPS.find((s) => s.id === id)?.label ?? id} → done`)
    const [d, ctl] = id.includes('.') ? (id.split('.') as ['A' | 'B', string]) : [null, id]
    const v = b.invert ? 127 - m.value : m.value
    if (!d) {
      if (ctl === 'xfader') mixer.setCrossfader(v / 127)
      if (ctl === 'browse') browse?.move(relative(m.value, b.rel)) // fast turns send bigger steps
      return
    }
    const deck: Deck = mixer.decks[d]
    const other = mixer.decks[d === 'A' ? 'B' : 'A']
    const pressed = m.kind === 'note' && m.value > 0
    switch (ctl) {
      case 'play': if (pressed) deck.toggle(); break
      case 'cue': if (pressed) deck.cue(); break
      case 'sync': if (pressed) deck.syncTo(other); break
      case 'fx1': case 'fx2': case 'fx3': {
        const slot = deck.channel.fx.slots[Number(ctl[2]) - 1]
        if (pressed) slot.setOn(!slot.on)
        break
      }
      case 'fx1lvl': case 'fx2lvl': case 'fx3lvl': deck.channel.fx.slots[Number(ctl[2]) - 1].setAmount(v / 127); break
      case 'fxbeats': deck.channel.fx.stepBeats(relative(m.value, b.rel)); break
      case 'load': if (pressed) browse?.load(d); break
      case 'keylock': if (pressed) void deck.setKeyLock(!deck.state.keyLock); break
      case 'loopauto': if (pressed) deck.autoLoop(); break
      case 'loophalf': if (pressed) deck.resizeLoop(0.5); break
      case 'loopdouble': if (pressed) deck.resizeLoop(2); break
      case 'loopin': if (pressed) deck.setLoopIn(); break
      case 'loopout': if (pressed) deck.setLoopOut(); break
      case 'reloop': if (pressed) deck.reloop(); break
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
  for (const d of ['A', 'B'] as const)
    mixer.decks[d].subscribe(() => {
      light(loadMap()[`${d}.play`], mixer.decks[d].state.playing)
      light(loadMap()[`${d}.keylock`], mixer.decks[d].state.keyLock)
    })
}
