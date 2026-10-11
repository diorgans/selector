"""Split one track into stems (vocals, drums, bass, other) with Demucs, on this Mac.

Usage: stems.py <input audio> <output dir>
Prints "STAGE <name>" and "PROGRESS <0..1>" lines for the app to show.
Writes <out>/{vocals,drums,bass,other}.flac (lossless, so stems stay sample-aligned
with the original) and <out>/done.json last, so a half-finished job never looks ready.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

MODEL = "htdemucs"  # Demucs v4 hybrid transformer: 4 stems


def say(*parts):
    print(*parts, flush=True)


def decode(path: str, tmp: str):
    """Read any format macOS can decode (mp3, m4a, wav, aiff, flac) as 44.1 kHz stereo."""
    try:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        if sr == 44100:
            return audio
    except Exception:
        pass
    wav = os.path.join(tmp, "input.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEF32@44100", "-c", "2", path, wav], check=True, capture_output=True)
    audio, _ = sf.read(wav, dtype="float32", always_2d=True)
    return audio


class Progress:
    """Demucs reports progress through tqdm on stderr; turn it into PROGRESS lines."""

    def __init__(self):
        self.last = -1

    def write(self, s):
        m = re.findall(r"(\d+)%\|", s)
        if m:
            p = int(m[-1])
            if p != self.last:
                self.last = p
                say("PROGRESS", p / 100)

    def flush(self):
        pass


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"

    say("STAGE loading-model")
    model = get_model(MODEL)  # downloads ~80 MB of weights the first time
    model.eval()

    with tempfile.TemporaryDirectory() as tmp:
        say("STAGE decoding")
        audio = decode(src, tmp)
        if audio.shape[1] == 1:
            audio = audio.repeat(2, axis=1)
        wav = torch.from_numpy(audio[:, :2].T.copy())

        say("STAGE separating", device)
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        real_stderr = sys.stderr
        sys.stderr = Progress()
        try:
            with torch.no_grad():
                sources = apply_model(model, ((wav - mean) / std)[None], device=device, split=True, overlap=0.25, progress=True)[0]
        finally:
            sys.stderr = real_stderr
        sources = sources * std + mean

        say("STAGE saving")
        for name, stem in zip(model.sources, sources):
            sf.write(os.path.join(out, f"{name}.flac"), stem.cpu().numpy().T, 44100, subtype="PCM_16")

    with open(os.path.join(out, "done.json"), "w") as f:
        json.dump({"model": MODEL, "stems": list(model.sources), "device": device}, f)
    say("DONE")


if __name__ == "__main__":
    main()
