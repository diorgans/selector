import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { getMixer } from './audio/engine.ts'
import { Visuals } from './Visuals.tsx'
import { capDevicePixelRatio } from './dpr.ts'

// Lets browser tests drive the mixer (development only).
if (import.meta.env.DEV) Object.assign(window, { __mixer: getMixer })

const isVisuals = location.hash === '#visuals'
if (isVisuals) {
  // The shader renderer sizes its canvas by devicePixelRatio; on Retina that
  // quadruples GPU work and drops frames, so report at most 1.5 (?dpr= overrides).
  capDevicePixelRatio(Number(new URLSearchParams(location.search).get('dpr')) || 1.5)
  document.documentElement.dataset.page = 'visuals'
}

createRoot(document.getElementById('root')!).render(<StrictMode>{isVisuals ? <Visuals /> : <App />}</StrictMode>)
