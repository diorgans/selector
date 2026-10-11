import { useEffect, useReducer, useRef, useState } from 'react'
import { getMixer } from './audio/engine.ts'
import { listOutputs, savedOutput, useOutput, type Output } from './output.ts'
import { browseStepsPerClick, relative, setBrowseStepsPerClick } from './midi.ts'
import { connect, ddjSrPreset, detectRel, deviceName, lastAction, loadMap, onAction, onMessage, same, saveMap, startController, STEPS, type Binding, type Msg } from './midi.ts'

/** The controller window: connect, learn each control, then use it. */
export function ControllerSetup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [device, setDevice] = useState(deviceName)
  const [error, setError] = useState<string>()
  const [map, setMap] = useState(loadMap)
  const [step, setStep] = useState<number | null>(null)
  const [last, setLast] = useState<Msg>()
  const [action, setAction] = useState(lastAction)
  const [outputs, setOutputs] = useState<Output[]>()
  const [calib, setCalib] = useState<'idle' | 'waiting' | string>('idle')
  // Browse calibration: add up the steps one physical click sends (messages within ~0.4 s).
  useEffect(() => {
    if (calib !== 'waiting') return
    const b = loadMap().browse
    if (!b) return setCalib('Map the browse knob first (Use DDJ-SR preset or Learn).')
    let total = 0
    let timer = 0
    return onMessage((m) => {
      if (!same(b, m)) return
      total += Math.abs(relative(m.value, b.rel))
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        setBrowseStepsPerClick(total)
        setCalib(`Done: one click = ${total} step${total === 1 ? '' : 's'}. Each click now moves one song.`)
      }, 400)
    })
  }, [calib])
  const [current, setCurrent] = useState<Output | null>(savedOutput)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => getMixer().master.subscribe(bump), [])
  async function findOutputs(autoPickController = false) {
    setError(undefined)
    try {
      const list = await listOutputs()
      setOutputs(list)
      const ddj = list.find((o) => /ddj|pioneer/i.test(o.label))
      if (autoPickController) {
        if (!ddj) return setError('No DJ controller found among sound outputs. Is it plugged in?')
        await useOutput(ddj)
        setCurrent(ddj)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => onAction(setAction), [])

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
    // Knobs: ignore controls already mapped (they jitter). Buttons: re-learning takes the
    // button over from any other control, so a learn can't silently record the wrong one.
    const taken = (m: Msg) => s.kind !== 'button' && Object.entries(map).some(([id, b]) => id !== s.id && same(b, m))
    const counts = new Map<string, { m: Msg; n: number; values: number[] }>()
    let timer = 0
    const done = (b: Binding) => {
      const next = Object.fromEntries(Object.entries(map).filter(([id, x]) => id === s.id || !same(x, { ...b, value: 0 })))
      next[s.id] = b
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
        if (!best || best.n < (s.kind === 'encoder' ? 2 : 3)) return
        // Tempo: the + end was reached first, so if it read low, the fader is upside down.
        const invert = s.kind === 'fader-end' ? best.values.slice(0, Math.ceil(best.values.length / 2)).reduce((a, v) => a + v, 0) / Math.ceil(best.values.length / 2) < 64 : undefined
        const rel = s.kind === 'jog' || s.kind === 'encoder' ? detectRel(best.values) : undefined
        done({ kind: 'cc', channel: best.m.channel, number: best.m.number, ...(invert ? { invert } : {}), ...(rel ? { rel } : {}) })
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
        <div className="ctl-sound">
          <h3>Sound output</h3>
          <p className="hint">
            Now: <strong>{current?.label ?? 'your Mac’s default output'}</strong> · {getMixer().master.outputChannels === 4 ? 'speakers on outputs 1–2, headphones on 3–4' : 'stereo only (no separate headphones)'}
          </p>
          <div className="row-btns">
            <button type="button" className="send" onClick={() => findOutputs(true)}>Use DDJ-SR for sound</button>
            <button type="button" className="pill" onClick={() => findOutputs(false)}>Choose another…</button>
          </div>
          {outputs && (
            <div className="row-btns">
              {outputs.map((o) => (
                <button key={o.deviceId} type="button" className="pill" aria-pressed={current?.deviceId === o.deviceId} onClick={async () => { await useOutput(o); setCurrent(o) }}>{o.label}</button>
              ))}
            </div>
          )}
          {/ddj|pioneer/i.test(current?.label ?? '') && getMixer().master.outputChannels < 4 && (
            <div className="ctl-note">
              <p><strong>Music is going to the controller (outputs 1–2).</strong> To hear it in your headphones, turn the controller’s headphone <strong>MIXING</strong> knob toward <strong>MASTER</strong>.</p>
              <p>To <strong>pre-listen</strong> with 🎧 CUE (the next song in your headphones only), Chrome needs the controller as your Mac’s main sound output: <strong>System Settings › Sound › Output › PIONEER DDJ-SR</strong>, then refresh this page. Selector switches to separate speaker and headphone outputs by itself when they’re available.</p>
            </div>
          )}
          <p className="hint">Chrome asks for microphone access only to show your sound devices; Selector never records.</p>
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
            <button type="button" className="send" disabled={!device || /No MIDI/.test(device)} onClick={() => { const m = ddjSrPreset(); setMap(m); saveMap(m) }}>Use DDJ-SR preset</button>
            <button type="button" className="pill" disabled={!device || /No MIDI/.test(device)} onClick={() => setStep(0)}>{learned ? 'Learn all again' : 'Learn controls one by one'}</button>
            <span className="hint">{learned} of {STEPS.length} controls mapped</span>
          </div>
        )}
        <p className="hint">Last message: {last ? `${last.kind === 'note' ? 'button' : 'knob'} ch ${last.channel + 1} #${last.number} = ${last.value}` : 'none yet'}</p>
        <p className="ctl-action" role="status">Last action: {action || 'press a mapped button'}</p>
        <div className="ctl-calib">
          <button type="button" className="pill" disabled={!device || calib === 'waiting'} onClick={() => setCalib('waiting')}>Calibrate browse wheel</button>
          <span className="hint" role="status">
            {calib === 'waiting' ? 'Turn the browse wheel exactly ONE click…' : calib === 'idle' ? `Now: ${browseStepsPerClick() ?? 'auto'} step(s) per click` : calib}
          </span>
        </div>
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
