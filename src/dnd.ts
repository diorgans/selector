import type { DragEvent } from 'react'
import type { Track } from '../shared/types.ts'

// Drag a track (from the list or Up next) onto a deck to load it.
export const TRACK_MIME = 'application/x-selector-track'

/** Props that make an element draggable as a track (only files Selector can play). */
export function trackDrag(t: Track) {
  if (!t.playable) return { draggable: false }
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(TRACK_MIME, t.id)
      e.dataTransfer.setData('text/plain', `${t.artist} – ${t.title}`)
      e.dataTransfer.effectAllowed = 'copy'
      document.documentElement.dataset.dragging = 'track'
    },
    onDragEnd: () => delete document.documentElement.dataset.dragging,
  }
}

export const isTrackDrag = (e: DragEvent) => e.dataTransfer.types.includes(TRACK_MIME)
