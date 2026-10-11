import { setOutputDevice } from './audio/engine.ts'

// Choosing where Selector's sound goes (e.g. the DJ controller's own sound card,
// whose outputs 3-4 feed its headphone socket). Chrome only reveals the list of
// sound devices after microphone permission; Selector never records anything.

const KEY = 'selector-output'
export type Output = { deviceId: string; label: string }

export async function listOutputs(): Promise<Output[]> {
  // Unlock device names and ids, then release the microphone straight away.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  stream.getTracks().forEach((t) => t.stop())
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default').map((d) => ({ deviceId: d.deviceId, label: d.label || 'Sound output' }))
}

export async function useOutput(o: Output) {
  await setOutputDevice(o.deviceId)
  try {
    localStorage.setItem(KEY, JSON.stringify(o))
  } catch {
    /* this visit only */
  }
}

export function savedOutput(): Output | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}

/** On start-up, go back to the output chosen last time (if it's still connected). */
export async function restoreOutput() {
  const o = savedOutput()
  if (!o) return
  try {
    await setOutputDevice(o.deviceId)
  } catch {
    /* device unplugged: stay on the default output */
  }
}
