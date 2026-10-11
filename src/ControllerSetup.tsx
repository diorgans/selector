import { useEffect, useRef, useState } from 'react'
import { connect, deviceName, loadMap, onMessage, same, saveMap, startController, STEPS, type Binding, type Msg } from './midi.ts'

/** The controller window: connect, learn each control, then use it. */
export function ControllerSetup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [device, setDevice] = useState(deviceName)
  const [error, setError] = useState<string>()
  const [map, setMap] = useState(loadMap)
  const [step, setStep] = useState<number | null>(null)
  const [last, setLast] = useState<Msg>()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  async function hookUp() {
    setError(undefined)
    try {
      const name = await connect()
      setDevice(name || 'No MIDI device found')
      startController()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Show every incoming message (for a quick "is it working" check).
  useEffect(() => onMessage(setLast), [])

  // Learning: wait for the control the current step asks for.
  useEffect(() => {
    if (step === null) return
    const s = STEPS[step]
    const taken = (m: Msg) => Object.entries(map).some(([id, b]) => id !== s.id && same(b, m))
    const counts = new Map<string, { m: Msg; n: number; values: number[] }>()
    let timer = 0
    const done = (b: Binding) => {
      const next = { ...map, [s.id]: b }
      setMap(next)
      saveMap(next)
      setStep(step + 1 < STEPS.length ? step + 1 : null)
    }
    return onMessage((m) => {
      if (taken(m)) return
      if (s.kind === 'button') {
        if (m.kind === 'note' && m.value > 0) done({ kind: 'note', channel: m.channel, number: m.number })
        return
      }
      if (m.kind !== 'cc') return
      // Knobs and wheels send a burst: pick the message that repeats most over ~1 s.
      const k = `${m.channel}:${m.number}`
      const c = counts.get(k) ?? { m, n: 0, values: [] }
      c.n++
      c.values.push(m.value)
      counts.set(k, c)
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        const best = [...counts.values()].sort((a, b) => b.n - a.n)[0]
        if (!best || best.n < 3) return
        // Tempo: the + end was reached first, so if it read low, the fader is upside down.
        const invert = s.kind === 'fader-end' ? best.values.slice(0, Math.ceil(best.values.length / 2)).reduce((a, v) => a + v, 0) / Math.ceil(best.values.length / 2) < 64 : undefined
        done({ kind: 'cc', channel: best.m.channel, number: best.m.number, ...(invert ? { invert } : {}) })
      }, 900)
    })
  }, [step, map])

  const learned = STEPS.filter((s) => map[s.id]).length
  const s = step !== null ? STEPS[step] : null
  return (
    <dialog ref={ref} className="shortcuts panel controller" aria-labelledby="ctl-h" onClose={() => (setStep(null), onClose())} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcuts-body">
        <div className="section-head">
          <h2 id="ctl-h">Controller</h2>
          <button type="button" className="pill" onClick={onClose}>Close <kbd>Esc</kbd></button>
        </div>
        <div className="ctl-status">
          <span className={`dot ${device && !/No MIDI/.test(device) ? 'on' : ''}`} aria-hidden />
          <span>{device || 'Not connected yet'}</span>
          <button type="button" className="pill" onClick={hookUp}>{device ? 'Reconnect' : 'Connect'}</button>
          <span className="hint">Chrome will ask to allow MIDI devices; choose Allow.</span>
        </div>
        {error && <p className="side-note err">{error}</p>}
        {s ? (
          <div className="ctl-learn" role="status">
            <div className="ctl-step">Step {step! + 1} of {STEPS.length}</div>
            <div className="ctl-ask">{s.label}</div>
            <p>{s.how}</p>
            <div className="row-btns">
              <button type="button" className="pill" onClick={() => setStep(step! + 1 < STEPS.length ? step! + 1 : null)}>Skip</button>
              <button type="button" className="pill" onClick={() => setStep(null)}>Stop</button>
            </div>
          </div>
        ) : (
          <div className="row-btns">
            <button type="button" className="send" disabled={!device || /No MIDI/.test(device)} onClick={() => setStep(0)}>{learned ? 'Set up again' : 'Set up controls'}</button>
            <span className="hint">{learned} of {STEPS.length} controls mapped</span>
          </div>
        )}
        <p className="hint">Last message: {last ? `${last.kind === 'note' ? 'button' : 'knob'} ch ${last.channel + 1} #${last.number} = ${last.value}` : 'none yet'}</p>
        <ul className="ctl-list">
          {STEPS.map((st, i) => (
            <li key={st.id} className={map[st.id] ? 'ok' : ''}>
              <span>{st.label}</span>
              <span className="hint">{map[st.id] ? `${map[st.id].kind === 'note' ? 'button' : 'knob'} #${map[st.id].number}` : '—'}</span>
              <button type="button" className="mini" disabled={!device} onClick={() => setStep(i)}>Learn</button>
            </li>
          ))}
        </ul>
      </div>
    </dialog>
  )
}
