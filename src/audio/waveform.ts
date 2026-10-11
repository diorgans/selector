// Three-band waveform, like rekordbox's RGB view: for each slice of the track,
// the peak level of the lows, mids and highs. Bands are split with simple
// one-pole filters, which is plenty for drawing.

export type Waveform = {
  binsPerSecond: number
  low: Float32Array
  mid: Float32Array
  high: Float32Array
}

export const BINS_PER_SECOND = 150

export function computeWaveform(buffer: AudioBuffer, binsPerSecond = BINS_PER_SECOND): Waveform {
  const sr = buffer.sampleRate
  const a = buffer.getChannelData(0)
  const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a
  const per = Math.max(1, Math.floor(sr / binsPerSecond))
  const n = Math.ceil(a.length / per)
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n)
  const kLow = 1 - Math.exp((-2 * Math.PI * 200) / sr)
  const kHigh = 1 - Math.exp((-2 * Math.PI * 2500) / sr)
  let lp = 0, lp2 = 0
  for (let i = 0; i < a.length; i++) {
    const x = (a[i] + b[i]) * 0.5
    lp += kLow * (x - lp) // below ~200 Hz
    lp2 += kHigh * (x - lp2) // below ~2.5 kHz
    const bin = (i / per) | 0
    const l = Math.abs(lp), m = Math.abs(lp2 - lp), h = Math.abs(x - lp2)
    if (l > low[bin]) low[bin] = l
    if (m > mid[bin]) mid[bin] = m
    if (h > high[bin]) high[bin] = h
  }
  // Normalise so quiet masters still draw a full-height waveform.
  const peak = Math.max(1e-6, ...[low, mid, high].map((arr) => arr.reduce((m, v) => (v > m ? v : m), 0)))
  for (const arr of [low, mid, high]) for (let i = 0; i < n; i++) arr[i] = Math.min(1, arr[i] / peak)
  return { binsPerSecond: per === 1 ? sr : sr / per, low, mid, high }
}
