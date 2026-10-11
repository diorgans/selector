"""Find BPM, musical key and the first beat of music files, on this Mac (Essentia).

Reads one JSON object per line on stdin: {"id": ..., "path": ...}
Writes one JSON object per line on stdout:
  {"id", "bpm", "key", "scale", "keyStrength", "firstBeat", "confidence"} or {"id", "error"}
Stays running, so the model setup happens once for a whole batch.
"""

import json
import sys

import numpy as np
import essentia
import essentia.standard as es

essentia.log.warningActive = False
SR = 44100
rhythm = es.RhythmExtractor2013(method="multifeature")
keyx = es.KeyExtractor(profileType="edma")  # key profiles tuned on electronic dance music


def tidy_bpm(bpm: float) -> float:
    """Most dance tracks are made at a whole BPM; snap analysis that lands very close to one."""
    r = round(bpm)
    return float(r) if abs(bpm - r) <= 0.35 else round(bpm, 2)


lowpass = es.LowPass(cutoffFrequency=150, sampleRate=SR)


def first_beat(audio: np.ndarray, bpm: float, seconds: int = 90) -> float:
    """Where the beatgrid starts (0 <= t < one beat), found from the kick drum.

    Keep only the bass (where kicks live), find where its energy jumps, then slide a
    comb with one tooth per beat across those jumps and keep the offset that lands on
    the most kick energy. Compared with rekordbox's grids on 21 songs this made no
    half-beat mistakes (Essentia's beat ticks made four).
    """
    x = lowpass(audio[: SR * seconds].astype(np.float32))
    hop = 220  # 5 ms frames
    n = len(x) // hop
    if n < 10:
        return 0.0
    env = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1))
    onset = np.maximum(0, np.diff(env, prepend=env[0]))
    beat_frames = (60.0 / bpm) * SR / hop
    best, best_score = 0.0, -1.0
    for ph in np.arange(0, beat_frames, 0.5):
        idx = np.round(np.arange(ph, n, beat_frames)).astype(int)
        idx = idx[idx < n]
        score = onset[idx].sum() + 0.5 * (onset[np.clip(idx - 1, 0, n - 1)].sum() + onset[np.clip(idx + 1, 0, n - 1)].sum())
        if score > best_score:
            best, best_score = float(ph), float(score)
    return round(best * hop / SR, 4)


def analyze(path: str) -> dict:
    audio = es.MonoLoader(filename=path, sampleRate=SR)()
    if len(audio) < SR * 5:
        raise ValueError("too short to analyse")
    bpm, ticks, confidence, _, _ = rhythm(audio)
    # Dance music sits roughly 85-175 BPM; fold half/double-time detections into it.
    while bpm < 85:
        bpm *= 2
    while bpm > 175:
        bpm /= 2
    bpm = tidy_bpm(float(bpm))
    key, scale, strength = keyx(audio)
    return {
        "bpm": bpm,
        "key": key,
        "scale": scale,
        "keyStrength": round(float(strength), 3),
        "firstBeat": first_beat(audio, bpm),
        "confidence": round(float(confidence), 2),
    }


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    job = json.loads(line)
    try:
        out = {"id": job["id"], **analyze(job["path"])}
    except Exception as e:  # one bad file shouldn't stop the batch
        out = {"id": job["id"], "error": str(e)[:200]}
    print(json.dumps(out), flush=True)
