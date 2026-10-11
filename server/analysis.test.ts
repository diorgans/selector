import { describe, expect, it } from 'vitest'
import { tidyBpm } from './analysis.ts'

describe('tidyBpm', () => {
  it('snaps near-whole tempos and keeps real decimals', () => {
    expect(tidyBpm(124.97)).toBe(125)
    expect(tidyBpm(128.3)).toBe(128)
    expect(tidyBpm(172.27)).toBe(172)
    expect(tidyBpm(172.6)).toBe(172.6)
    expect(tidyBpm(129.52)).toBe(129.52)
  })
})
