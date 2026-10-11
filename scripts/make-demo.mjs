// Generates two original demo loops (kick, hats, bass, chords) as tagged WAV
// files in ~/.selector/demo, so the player can be tested without real music.
// Usage: node scripts/make-demo.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SR = 44100
const out = process.argv[2] ?? join(homedir(), '.selector', 'demo')

function synth({ bpm, rootHz, chord, seconds, offset }) {
  const n = Math.round(seconds * SR)
  const L = new Float32Array(n), R = new Float32Array(n)
  const beat = 60 / bpm
  let seed = 1
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR - offset
    if (t < 0) continue
    const b = t / beat, inBeat = (b % 1) * beat, bar = Math.floor(b / 4)
    // kick: falling sine on every beat
    const kf = 45 + 80 * Math.exp(-inBeat * 30)
    const kick = Math.sin(2 * Math.PI * kf * inBeat) * Math.exp(-inBeat * 9) * 0.9
    // hats: short noise on the off-beat
    const off = ((b + 0.5) % 1) * beat
    const hat = noise() * Math.exp(-off * 60) * 0.18
    // bass: root / fifth pattern on 8ths, ducked under the kick
    const eighth = Math.floor(b * 2) % 8
    const bassHz = rootHz * ([1, 1, 1.5, 1, 1, 1.335, 1.5, 1][eighth])
    const bass = Math.tanh(2 * Math.sin(2 * Math.PI * bassHz * t)) * 0.22 * (1 - Math.exp(-inBeat * 12))
    // chords: soft stab every 2 bars
    const stabT = t - bar * 4 * beat
    const pad = bar % 2 === 0 ? chord.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * 0.06 * Math.exp(-stabT * 1.2) : 0
    const mix = kick + bass + pad
    L[i] = Math.tanh(mix + hat * 0.7)
    R[i] = Math.tanh(mix + hat * 1.0)
  }
  return [L, R]
}

// Minimal ID3v2.3 tag (title, artist, BPM, key) inside the WAV's "id3 " chunk.
function id3(tags) {
  const frames = Object.entries(tags).map(([id, text]) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')])
    const h = Buffer.alloc(10)
    h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4)
    return Buffer.concat([h, body])
  })
  const content = Buffer.concat(frames)
  const size = content.length
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127])
  return Buffer.concat([header, content])
}

function wav([L, R], tags) {
  const pcm = Buffer.alloc(L.length * 4)
  for (let i = 0; i < L.length; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), i * 4)
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), i * 4 + 2)
  }
  const tag = id3(tags)
  const tagPad = tag.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10)
  fmt.writeUInt32LE(SR, 12); fmt.writeUInt32LE(SR * 4, 16); fmt.writeUInt16LE(4, 20); fmt.writeUInt16LE(16, 22)
  const dataH = Buffer.alloc(8); dataH.write('data', 0); dataH.writeUInt32LE(pcm.length, 4)
  const id3H = Buffer.alloc(8); id3H.write('id3 ', 0); id3H.writeUInt32LE(tag.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, dataH, pcm, id3H, tag, tagPad])
  const riff = Buffer.alloc(8); riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

mkdirSync(out, { recursive: true })
const A = 110, E = 164.81
const demos = [
  { file: 'Selector Demo - Night Drive.wav', bpm: 124, rootHz: A / 2, chord: [220, 261.63, 329.63], key: 'Am', title: 'Night Drive' },
  { file: 'Selector Demo - Lift Off.wav', bpm: 126, rootHz: E / 2, chord: [164.81, 196, 246.94], key: 'Em', title: 'Lift Off' },
]
for (const d of demos) {
  const audio = synth({ bpm: d.bpm, rootHz: d.rootHz, chord: d.chord, seconds: 64, offset: 0.5 })
  writeFileSync(join(out, d.file), wav(audio, { TIT2: d.title, TPE1: 'Selector Demo', TBPM: String(d.bpm), TKEY: d.key }))
  console.log('wrote', join(out, d.file))
}
