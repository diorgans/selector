import type { RawTrack } from './rekordbox.ts'

// Writes Selector's sets as a rekordbox XML file. rekordbox loads it through
// Preferences › Imported Library and shows it under "rekordbox xml" (tested in
// Phase 0: imported playlists play, streaming tracks included, and Automix runs them).
// This is always a separate file; rekordbox's own library is never written.

export type SetList = { id: string; name: string; trackIds: string[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const attrs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}="${esc(v as string)}"`)
    .join(' ')

function trackXml(t: RawTrack): string {
  const children = [...(t.TEMPO ?? []).map((x) => `      <TEMPO ${attrs(x)}/>`), ...(t.POSITION_MARK ?? []).map((x) => `      <POSITION_MARK ${attrs(x)}/>`)]
  return children.length ? `    <TRACK ${attrs(t)}>\n${children.join('\n')}\n    </TRACK>` : `    <TRACK ${attrs(t)}/>`
}

export function buildRekordboxXml(sets: SetList[], raw: Map<string, RawTrack>): string {
  const missing = sets.flatMap((s) => s.trackIds).filter((id) => !raw.has(id))
  if (missing.length) throw new Error(`Unknown track ids (re-export from rekordbox?): ${missing.slice(0, 5).join(', ')}`)
  const ids = [...new Set(sets.flatMap((s) => s.trackIds))]
  // rekordbox can't hold two playlists with the same name in one folder.
  const seen = new Map<string, number>()
  const named = sets.map((s) => {
    const n = (seen.get(s.name) ?? 0) + 1
    seen.set(s.name, n)
    return { ...s, name: n > 1 ? `${s.name} (${n})` : s.name }
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="rekordbox" Version="7.2.19" Company="AlphaTheta"/>',
    `  <COLLECTION Entries="${ids.length}">`,
    ...ids.map((id) => trackXml(raw.get(id)!)),
    '  </COLLECTION>',
    '  <PLAYLISTS>',
    '    <NODE Type="0" Name="ROOT" Count="1">',
    `      <NODE Type="0" Name="Selector" Count="${named.length}">`,
    ...named.map((s) =>
      [`        <NODE Name="${esc(s.name)}" Type="1" KeyType="0" Entries="${s.trackIds.length}">`, ...s.trackIds.map((id) => `          <TRACK Key="${esc(id)}"/>`), '        </NODE>'].join('\n'),
    ),
    '      </NODE>',
    '    </NODE>',
    '  </PLAYLISTS>',
    '</DJ_PLAYLISTS>',
    '',
  ].join('\n')
}
