import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRekordboxXml } from './exportXml.ts'
import { parseRekordboxXml } from './rekordbox.ts'

const { raw } = parseRekordboxXml(readFileSync(new URL('./__fixtures__/rekordbox.xml', import.meta.url), 'utf8'))

describe('buildRekordboxXml', () => {
  const xml = buildRekordboxXml([{ id: 's1', name: 'Friday <warm-up>', trackIds: ['4', '1'] }, { id: 's2', name: 'Friday <warm-up>', trackIds: ['2'] }], raw)
  it('round-trips through the rekordbox parser with tracks unchanged', () => {
    const back = parseRekordboxXml(xml)
    expect(back.tracks.map((t) => t.id).sort()).toEqual(['1', '2', '4'])
    expect(back.raw.get('1')).toEqual(raw.get('1')) // TEMPO grid and every attribute preserved
    expect(back.playlists).toEqual([
      { path: ['Selector', 'Friday <warm-up>'], trackIds: ['4', '1'] },
      { path: ['Selector', 'Friday <warm-up> (2)'], trackIds: ['2'] },
    ])
  })
  it('keeps the streaming location exactly as rekordbox wrote it', () => {
    expect(xml).toContain('Location="file://localhostapple-music:tracks:111"')
  })
  it('refuses unknown track ids', () => {
    expect(() => buildRekordboxXml([{ id: 'x', name: 'x', trackIds: ['nope'] }], raw)).toThrow(/Unknown track ids/)
  })
})
