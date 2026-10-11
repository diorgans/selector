import { describe, expect, it } from 'vitest'
import { parse, same } from './midi.ts'

describe('MIDI parsing', () => {
  it('reads buttons (note on / off) and knobs (control change) with their channel', () => {
    expect(parse(new Uint8Array([0x90, 0x0b, 0x7f]))).toEqual({ kind: 'note', channel: 0, number: 11, value: 127 })
    expect(parse(new Uint8Array([0x91, 0x0b, 0x00]))).toEqual({ kind: 'note', channel: 1, number: 11, value: 0 })
    expect(parse(new Uint8Array([0x81, 0x0c, 0x40]))).toEqual({ kind: 'note', channel: 1, number: 12, value: 0 })
    expect(parse(new Uint8Array([0xb6, 0x1f, 0x40]))).toEqual({ kind: 'cc', channel: 6, number: 31, value: 64 })
    expect(parse(new Uint8Array([0xf8]))).toBeNull() // clock and other system messages are ignored
  })
  it('matches a learned binding only on the same kind, channel and number', () => {
    const b = { kind: 'note' as const, channel: 0, number: 11 }
    expect(same(b, { kind: 'note', channel: 0, number: 11, value: 127 })).toBe(true)
    expect(same(b, { kind: 'note', channel: 1, number: 11, value: 127 })).toBe(false)
    expect(same(b, { kind: 'cc', channel: 0, number: 11, value: 64 })).toBe(false)
  })
})

import { detectRel, relative } from './midi.ts'
describe('relative knobs (jog wheels, browse)', () => {
  it('reads both encodings and detects which one a controller uses', () => {
    expect(relative(65, 'center')).toBe(1)
    expect(relative(62, 'center')).toBe(-2)
    expect(relative(1, 'twos')).toBe(1)
    expect(relative(127, 'twos')).toBe(-1)
    expect(detectRel([65, 66, 65, 64])).toBe('center')
    expect(detectRel([1, 1, 2, 127])).toBe('twos')
  })
})

import { ddjSrPreset, STEPS } from './midi.ts'
describe('DDJ-SR preset', () => {
  const p = ddjSrPreset()
  it('matches the messages captured from the controller', () => {
    expect(p['A.play']).toEqual({ kind: 'note', channel: 0, number: 0x0b })
    expect(p['A.sync']).toEqual({ kind: 'note', channel: 0, number: 0x58 })
    expect(p['A.keylock']).toEqual({ kind: 'note', channel: 0, number: 0x1a })
    expect(p['A.loopauto']).toEqual({ kind: 'note', channel: 0, number: 0x14 })
    expect(p['A.fx1']).toEqual({ kind: 'note', channel: 4, number: 0x47 })
    expect(p['A.load']).toEqual({ kind: 'note', channel: 6, number: 0x46 })
  })
  it('covers every control the setup knows, with no two controls on one message', () => {
    expect(STEPS.filter((s) => !p[s.id]).map((s) => s.id)).toEqual([])
    const keys = Object.values(p).map((b) => `${b.kind}${b.channel}:${b.number}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
