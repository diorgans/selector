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


def first_beat(ticks: np.ndarray, bpm: float) -> float:
    """Where the beatgrid starts: the earliest beat, using the median phase of all beats so one stray tick can't shift it."""
    beat = 60.0 / bpm
    phase = float(np.median(np.mod(ticks, beat)))
    return round(phase, 4)


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
    key, scale, strength = keyx(audio)
    return {
        "bpm": round(float(bpm), 2),
        "key": key,
        "scale": scale,
        "keyStrength": round(float(strength), 3),
        "firstBeat": first_beat(np.array(ticks), bpm) if len(ticks) else 0.0,
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
