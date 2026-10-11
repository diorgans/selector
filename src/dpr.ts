// The shader renderer sizes its canvas by devicePixelRatio; on Retina that
// quadruples GPU work and drops frames. Report at most `max` (canvas text and
// layout are unaffected; only scripts read this value).
let capped = false
export function capDevicePixelRatio(max: number) {
  if (capped) return
  const d = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') ?? Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio')
  if (!d?.get) return
  const native = d.get
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => Math.min(native.call(window), max) })
  capped = true
}
