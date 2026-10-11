import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { getMixer } from './audio/engine.ts'

// Lets browser tests drive the mixer (development only).
if (import.meta.env.DEV) Object.assign(window, { __mixer: getMixer })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
