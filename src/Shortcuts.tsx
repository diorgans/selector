import { useEffect, useRef } from 'react'

// The keyboard guide: every shortcut, plus a short "how to use Selector".
// Opens with the ⌨ button or "?"; Esc or clicking outside closes it.

export const KEYS: { group: string; items: { keys: string[]; does: string }[] }[] = [
  {
    group: 'Decks',
    items: [
      { keys: ['Q', 'P'], does: 'Play / pause deck A / deck B' },
      { keys: ['A', 'L'], does: 'Cue: while playing, jump back to the cue point; while stopped, set it here' },
      { keys: ['S', 'K'], does: 'Sync: match the other deck’s tempo and line up the beats' },
      { keys: ['Z', 'M'], does: 'Load the selected track onto deck A / deck B' },
      { keys: ['E', 'I'], does: 'Effect on / off for deck A / deck B (choose the effect, beats and amount on the deck)' },
    ],
  },
  {
    group: 'Mixer',
    items: [
      { keys: ['←', '→'], does: 'Move the crossfader toward deck A / deck B' },
      { keys: ['Double-click'], does: 'Reset any slider (EQ, filter, tempo, faders) to its centre' },
    ],
  },
  {
    group: 'Browsing',
    items: [
      { keys: ['/'], does: 'Jump to search' },
      { keys: ['?'], does: 'Show or hide this guide' },
      { keys: ['Esc'], does: 'Close this guide' },
    ],
  },
]

const HOW = [
  'Pick a crate on the left: My Library for music files you own, Apple Music for your playlists.',
  'Click a track. Songs that mix well with it light up, and Up next suggests what to play after it.',
  'Press A or B on a row (or Z / M) to load it onto a deck. ☁ songs stream from Apple Music, so play those in rekordbox.',
  'Press play, then SYNC on the second deck to lock the beats together. Blend with the EQ and the crossfader.',
  'On a deck, ✂ Split stems separates vocals, instruments and drums (once per song, on your Mac). Click a part to mute it, or slide to fade it.',
  'Build a set with ＋, then Send to rekordbox to play it there, Automix included.',
]

export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="shortcuts panel"
      aria-labelledby="keys-h"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="shortcuts-body">
        <div className="section-head">
          <h2 id="keys-h">Keyboard &amp; how to use Selector</h2>
          <button type="button" className="pill" onClick={onClose} autoFocus>Close <kbd>Esc</kbd></button>
        </div>
        <div className="shortcuts-cols">
          <div>
            {KEYS.map((g) => (
              <section key={g.group}>
                <h3>{g.group}</h3>
                <dl>
                  {g.items.map((it) => (
                    <div key={it.does} className="kbd-row">
                      <dt>{it.keys.map((k, i) => <span key={k}>{i > 0 && <span className="or"> / </span>}<kbd>{k}</kbd></span>)}</dt>
                      <dd>{it.does}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          <section>
            <h3>How it works</h3>
            <ol className="how">{HOW.map((h) => <li key={h}>{h}</li>)}</ol>
          </section>
        </div>
      </div>
    </dialog>
  )
}
