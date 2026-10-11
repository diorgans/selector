// Key lock: change tempo without changing pitch (WSOLA time-stretching).
//
// The track is cut into overlapping 2048-sample slices (Hann-windowed, 50% overlap).
// Output slices are laid down every HS samples; input slices are taken every
// HS * rate samples, so the track moves at `rate` speed while each slice keeps its
// original pitch. Each slice is nudged (within ±SEARCH samples) to where it best
// continues the previous one, which avoids a warbly, phasey sound.
//
// One node plays several sources at once (the full mix, or the four stems), using
// the SAME slice positions for all of them, so stems stay sample-aligned.

const N = 2048
const HS = N / 2
const SEARCH = 256
const CORR = 512
const STEP = 4

class StretchPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.sources = [] // [[left, right], ...]
    this.rate = 1
    this.playing = false
    this.startFrame = 0
    this.window = new Float32Array(N)
    for (let i = 0; i < N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N) // periodic Hann: overlaps sum to 1
    this.outputsCount = options.numberOfOutputs
    this.port.onmessage = (e) => this.message(e.data)
  }

  message(m) {
    if (m.type === 'load') {
      this.sources = m.sources
      this.length = Math.min(...this.sources.map((s) => s[0].length))
    } else if (m.type === 'rate') {
      this.rate = m.rate
    } else if (m.type === 'start') {
      this.rate = m.rate
      this.begin(Math.round(m.when * sampleRate), m.offset * sampleRate)
    } else if (m.type === 'loop') {
      // Loop region in samples (null = no loop). The read position wraps at its end.
      this.loopStart = m.start === null ? null : m.start * sampleRate
      this.loopEnd = m.end === null ? null : m.end * sampleRate
    } else if (m.type === 'stop') {
      this.playing = false
    }
  }

  begin(startFrame, offset) {
    const k = this.sources.length
    this.overlap = Array.from({ length: k }, () => [new Float32Array(N), new Float32Array(N)])
    this.ready = Array.from({ length: k }, () => [new Float32Array(0), new Float32Array(0)])
    this.readPos = 0
    // Output sample t should come from input offset + t*rate. A slice centred on
    // output t comes from its input start + N/2, hence this starting point.
    this.nominal = offset - (N / 2) * (1 - this.rate)
    this.prevStart = null
    this.startFrame = startFrame
    this.playing = true
    // Pre-roll one hop (discarded) so playback starts at full level, not faded in.
    this.nominal -= HS * this.rate
    this.hop()
    for (const r of this.ready) (r[0] = new Float32Array(0)), (r[1] = new Float32Array(0))
  }

  /** Mono mix of all sources at input index i (used only to choose slice positions). */
  mono(i) {
    if (i < 0 || i >= this.length) return 0
    let s = 0
    for (const src of this.sources) s += src[0][i] + src[1][i]
    return s
  }

  /** Synthesize one hop (HS samples) for every source. */
  hop() {
    let start = Math.round(this.nominal)
    if (this.prevStart !== null) {
      // Find the offset where the new slice best continues the previous one.
      const natural = this.prevStart + HS
      // Normalised correlation, gently biased toward the nominal position so sharp
      // sounds (kicks, claps) aren't skipped or doubled when the fit is close.
      let best = 0, bestScore = -Infinity
      for (let k = -SEARCH; k <= SEARCH; k += STEP) {
        let xy = 0, yy = 1e-9
        for (let j = 0; j < CORR; j += 2) {
          const y = this.mono(start + k + j)
          xy += this.mono(natural + j) * y
          yy += y * y
        }
        const score = (xy / Math.sqrt(yy)) * (1 - 0.35 * Math.abs(k) / SEARCH)
        if (score > bestScore) (bestScore = score), (best = k)
      }
      start += best
    }
    for (let s = 0; s < this.sources.length; s++) {
      const src = this.sources[s], ov = this.overlap[s]
      for (let ch = 0; ch < 2; ch++) {
        const x = src[ch], o = ov[ch]
        for (let i = 0; i < N; i++) {
          const idx = start + i
          o[i] += (idx >= 0 && idx < this.length ? x[idx] : 0) * this.window[i]
        }
        // The first HS samples are now complete.
        const done = o.slice(0, HS)
        o.copyWithin(0, HS)
        o.fill(0, N - HS)
        const r = this.ready[s][ch]
        const merged = new Float32Array(r.length - this.readPos + HS)
        merged.set(r.subarray(this.readPos))
        merged.set(done, r.length - this.readPos)
        this.ready[s][ch] = merged
      }
    }
    this.readPos = 0
    this.prevStart = start
    this.nominal += HS * this.rate
    if (this.loopEnd != null && this.nominal >= this.loopEnd) this.nominal -= this.loopEnd - this.loopStart
  }

  process(_inputs, outputs) {
    if (!this.playing || !this.sources.length) return true
    const block = outputs[0][0].length
    // Wait for the scheduled start, to the sample.
    let from = 0
    if (currentFrame + block <= this.startFrame) return true
    if (currentFrame < this.startFrame) from = this.startFrame - currentFrame
    const need = block - from
    while (this.ready[0][0].length - this.readPos < need) this.hop()
    for (let s = 0; s < this.sources.length && s < outputs.length; s++)
      for (let ch = 0; ch < 2; ch++) outputs[s][ch]?.set(this.ready[s][ch].subarray(this.readPos, this.readPos + need), from)
    this.readPos += need
    if (this.nominal > this.length + N) {
      this.playing = false
      this.port.postMessage({ type: 'ended' })
    }
    return true
  }
}

registerProcessor('stretch-player', StretchPlayer)
