import { describe, expect, it } from 'vitest'
import type { Track } from '../shared/types.ts'
import { folderTree, inFolder } from './libraryGroups.ts'

const t = (path: string): Track => ({ id: path, title: '', artist: '', album: '', genre: '', bpm: null, key: null, durationSec: 0, source: 'file', location: `file://localhost${encodeURI(path).replace(/#/g, '%23')}`, playCount: 0, rating: 0, dateAdded: '', crates: [], playable: true })

describe('folderTree', () => {
  const tracks = [t('/Volumes/T/House/a.mp3'), t('/Volumes/T/House/b.mp3'), t('/Volumes/T/Contents/Bootie Grove/#FFFF00/c.mp3'), t('/Volumes/T/loose.mp3'), t('/Users/x/Music/d.mp3')]
  it('nests folders with song counts, keeping "#" in names', () => {
    const tree = folderTree(tracks, '/Volumes/T')
    expect(tree.map((n) => [n.name, n.count])).toEqual([['Contents', 1], ['House', 2]])
    expect(tree[0].children[0].children[0]).toMatchObject({ name: '#FFFF00', count: 1, path: '/Volumes/T/Contents/Bootie Grove/#FFFF00' })
  })
  it('selects every song under a folder', () => {
    expect(tracks.filter((x) => inFolder(x, '/Volumes/T/Contents')).length).toBe(1)
    expect(tracks.filter((x) => inFolder(x, '/Volumes/T/House')).length).toBe(2)
  })
})
