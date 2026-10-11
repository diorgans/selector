import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toCamelot } from '../shared/camelot.ts'
import { parseAppleLibrary } from './apple.ts'
import { buildLibrary, normalize } from './library.ts'
import { parseRekordboxXml } from './rekordbox.ts'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

describe('toCamelot', () => {
  it('accepts Camelot and music notation', () => {
    expect(toCamelot('8a')).toBe('8A')
    expect(toCamelot('Am')).toBe('8A')
    expect(toCamelot('F#m')).toBe('11A')
    expect(toCamelot('C')).toBe('8B')
    expect(toCamelot('')).toBeNull()
    expect(toCamelot('13A')).toBeNull()
  })
})

describe('parseRekordboxXml', () => {
  const rb = parseRekordboxXml(fixture('rekordbox.xml'))
  it('reads tracks and skips sampler sounds', () => {
    expect(rb.tracks.map((t) => t.id)).toEqual(['1', '2', '4'])
    const [a, b] = rb.tracks
    expect(a).toMatchObject({ bpm: 124, key: '8A', source: 'streaming', rating: 4, playCount: 3, durationSec: 200 })
    expect(b).toMatchObject({ bpm: null, key: '8A', source: 'file', artist: 'Other & Co' })
    expect(a.location).toBe('file://localhostapple-music:tracks:111')
  })
  it('reads nested playlists with their folder path', () => {
    expect(rb.playlists).toEqual([{ path: ['Gigs', 'Friday'], trackIds: ['4', '1', '999'] }])
  })
  it('rejects files that are not collection exports', () => {
    expect(() => parseRekordboxXml('<foo/>')).toThrow(/COLLECTION/)
  })
})

describe('buildLibrary', () => {
  const lib = buildLibrary(parseRekordboxXml(fixture('rekordbox.xml')), parseAppleLibrary(fixture('apple.xml')))
  it('matches Apple songs to rekordbox tracks by artist + title, ignoring "feat."', () => {
    const crate = lib.crates.find((c) => c.name === 'House Grooves')!
    expect(crate).toMatchObject({ origin: 'apple', trackIds: ['1'], totalItems: 2 })
    expect(lib.stats.appleMatched).toBe(1)
  })
  it('keeps rekordbox playlists, dropping ids it does not know', () => {
    expect(lib.crates.find((c) => c.name === 'Gigs / Friday')).toMatchObject({ trackIds: ['4', '1'], totalItems: 3 })
  })
  it('records crate membership on tracks and counts stats', () => {
    expect(lib.tracks.find((t) => t.id === '1')!.crates).toHaveLength(2)
    expect(lib.stats).toMatchObject({ tracks: 3, analyzed: 2, streaming: 2, files: 1 })
  })
  it('normalizes titles for matching', () => {
    expect(normalize('Love & War (feat. Queen Naija) [Remix]')).toBe('love and war remix')
  })
})

import { harmonicNeighbors } from '../shared/camelot.ts'
describe('harmonicNeighbors', () => {
  it('wraps around the wheel and includes the relative key', () => {
    expect(harmonicNeighbors('12A')).toEqual(['12A', '11A', '1A', '12B'])
    expect(harmonicNeighbors('1B')).toEqual(['1B', '12B', '2B', '1A'])
  })
})

import { bpmCompatible, mixesWell } from '../shared/camelot.ts'
describe('bpmCompatible / mixesWell', () => {
  it('allows about 6%, plus half and double time', () => {
    expect(bpmCompatible(124, 128)).toBe(true)
    expect(bpmCompatible(124, 134)).toBe(false)
    expect(bpmCompatible(140, 70)).toBe(true)
    expect(bpmCompatible(85, 172)).toBe(true)
    expect(bpmCompatible(null, 120)).toBe(false)
  })
  it('needs both a neighbouring key and a matchable tempo', () => {
    expect(mixesWell({ key: '8A', bpm: 124 }, { key: '9A', bpm: 126 })).toBe(true)
    expect(mixesWell({ key: '8A', bpm: 124 }, { key: '3B', bpm: 124 })).toBe(false)
    expect(mixesWell({ key: '8A', bpm: 124 }, { key: '8A', bpm: 100 })).toBe(false)
  })
})

import { locationToPath, pathToLocation } from './files.ts'
describe('file locations', () => {
  it('keeps "#" and "?" in file and folder names (they are not URL fragments)', () => {
    const paths = ['/Volumes/Drive/Contents/Bootie Grove/#FFFF00/Choices.mp3', '/Volumes/Drive/House/DubPlates #8 - Dub.wav', '/Volumes/Drive/Where You Gonna Go?.mp3', '/Users/x/Music/100% Café.mp3']
    for (const p of paths) expect(locationToPath(pathToLocation(p))).toBe(p)
    // Locations already stored with a raw "#" (older scans) still resolve to the file, not its folder.
    expect(locationToPath('file://localhost/Volumes/Trojan/Rap/ARP%20TR1CK#%20-%20FNX.mp3')).toBe('/Volumes/Trojan/Rap/ARP TR1CK# - FNX.mp3')
  })
})
