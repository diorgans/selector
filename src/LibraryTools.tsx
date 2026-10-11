import { useEffect, useState } from 'react'
import type { Library } from '../shared/types.ts'
import { addFolder, fetchAnalysis, fetchFolders, startAnalysis, type AnalysisStatus, type Drive } from './api.ts'

/** My Library extras: connected drives (scan / rescan) and the BPM + key analysis progress. */
export function LibraryTools({ lib, onChanged }: { lib: Library; onChanged: () => void }) {
  const [drives, setDrives] = useState<Drive[]>([])
  const [scanning, setScanning] = useState<string>()
  const [analysis, setAnalysis] = useState<AnalysisStatus>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    fetchFolders().then((f) => setDrives(f.drives), () => {})
  }, [])

  // Poll analysis while it runs, and refresh the library so new BPMs and keys show up.
  useEffect(() => {
    let stop = false
    let ticks = 0
    const poll = async () => {
      try {
        const a = await fetchAnalysis()
        if (stop) return
        setAnalysis(a)
        if (a.running) {
          if (++ticks % 5 === 0) onChanged()
          setTimeout(poll, 3000)
        } else if (ticks) onChanged()
      } catch {
        /* server restarting */
      }
    }
    void poll()
    return () => void (stop = true)
  }, [analysis?.running, onChanged])

  const missing = lib.tracks.filter((t) => t.source === 'file' && t.playable && (!t.bpm || !t.key)).length

  async function scan(d: Drive) {
    setScanning(d.path)
    setError(undefined)
    try {
      setDrives((await addFolder(d.path)).drives)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(undefined)
    }
  }

  return (
    <div className="libtools">
      {drives.length > 0 && <div className="side-label">Drives</div>}
      {drives.map((d) => (
        <div key={d.path} className="drive">
          <span className="crate-name">⏏ {d.name}</span>
          <button type="button" className="mini" disabled={!!scanning} onClick={() => scan(d)} title={d.scanned ? 'Look for new or changed files on this drive' : 'Add this drive to your library'}>
            {scanning === d.path ? 'Scanning…' : d.scanned ? 'Rescan' : 'Add'}
          </button>
        </div>
      ))}
      {scanning && <p className="side-note">Big USB drives can take a few minutes to read. Songs appear when it's done.</p>}

      <div className="side-label">Analysis</div>
      {analysis?.running ? (
        <div className="analysis" role="status">
          <div className="analysis-head"><span>Analyzing BPM and key</span><span className="count">{analysis.done} / {analysis.total}</span></div>
          <span className="bar"><span style={{ width: `${(analysis.done / Math.max(1, analysis.total)) * 100}%` }} /></span>
          <span className="analysis-now">{analysis.current}</span>
        </div>
      ) : missing > 0 ? (
        <div className="analysis">
          <button type="button" className="pill" disabled={analysis?.installed === false} onClick={() => startAnalysis().then(setAnalysis, (e) => setError(String(e.message ?? e)))}>
            Analyze {missing} song{missing === 1 ? '' : 's'}
          </button>
          <span className="side-note">Finds BPM, key and the beatgrid on your Mac, so these songs can sync, get suggestions and automix.</span>
        </div>
      ) : (
        <p className="side-note">Every song has a BPM and key. ✓</p>
      )}
      {error && <p className="side-note err">{error}</p>}
    </div>
  )
}
