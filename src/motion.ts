import { flushSync } from 'react-dom'

// Smooth UI changes with the browser's View Transitions: the old view animates
// into the new one. `kind` lets CSS pick a style (crate, tab, reorder, look).
// Skipped entirely when the system asks for reduced motion.

type VTDocument = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }

export function withTransition(fn: () => void, kind = 'fade') {
  const doc = document as VTDocument
  if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return fn()
  document.documentElement.dataset.vt = kind
  doc.startViewTransition(() => flushSync(fn)).finished.finally(() => {
    if (document.documentElement.dataset.vt === kind) delete document.documentElement.dataset.vt
  })
}

/** View-transition names must be CSS identifiers; ids can start with digits. */
export const vtName = (prefix: string, id: string) => `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
