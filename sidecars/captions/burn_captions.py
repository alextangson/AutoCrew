"""Burn style-A English captions into the English cut (full-media spec §3.3 "Captions").

Style A (founder-approved, Ali Abdaal-like): Avenir Next Demi Bold 54 px, white, soft dark shadow,
at most two lines bottom-center, at most one yellow keyword per cue (marked [like this] in the cue
text), whole cue in and out. Cue text and timing come from `autocrew_content en_edition captions`
(approved script + ElevenLabs word timestamps); this script never edits the words.

ffmpeg on this machine has no libass, so each cue is rendered to a transparent PNG with Pillow and
overlaid with ffmpeg `overlay=enable='between(t,s,e)'`.

Usage:
  uv run --project sidecars/captions sidecars/captions/burn_captions.py \
      --cues captions.json --input lipsynced.mp4 --output english-cut.mp4 [--font PATH] [--check]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

W, H = 1920, 1080
WHITE, YELLOW = (255, 255, 255, 255), (255, 214, 10, 255)
FONT_SIZE = 54
DEFAULT_FONT = "/System/Library/Fonts/Avenir Next.ttc"
DEMI_BOLD_INDEX = 2  # face index of "Avenir Next Demi Bold" inside the .ttc
LINE_MAX = 42


class CueError(ValueError):
    pass


def runs(line: str) -> list[tuple[str, bool]]:
    """Split a line into (text, is_keyword) runs; [..] marks the keyword."""
    out, hl = [], False
    for part in line.replace("]", "[").split("["):
        if part:
            out.append((part, hl))
        hl = not hl
    return out


def keyword_count(lines: list[str]) -> int:
    """A keyword wrapped across the line break ([max\neffort]) is marked on both lines but counts once."""
    flags = [[k for _, k in runs(x)] for x in lines]
    n = sum(1 for f in flags for k in f if k)
    if len(flags) == 2 and flags[0] and flags[1] and flags[0][-1] and flags[1][0]:
        n -= 1
    return n


def has_audio(src: str) -> bool:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise CueError(f"cannot read input video: {src} ({out.stderr.strip() or 'ffprobe failed'})")
    return bool(out.stdout.strip())


def validate(cues: list[dict]) -> None:
    """Refuse anything outside style A instead of silently rendering it."""
    prev_end = -1.0
    for i, c in enumerate(cues, 1):
        lines, s, e = c.get("lines"), c.get("start"), c.get("end")
        if not isinstance(lines, list) or not 1 <= len(lines) <= 2 or not all(isinstance(x, str) and x.strip() for x in lines):
            raise CueError(f"cue {i}: needs 1-2 non-empty lines")
        if not isinstance(s, (int, float)) or not isinstance(e, (int, float)) or e <= s:
            raise CueError(f"cue {i}: start/end must be numbers with end > start")
        if s < prev_end:
            raise CueError(f"cue {i}: overlaps the previous cue")
        if keyword_count(lines) > 1:
            raise CueError(f"cue {i}: more than one yellow keyword")
        if any(len(x.replace("[", "").replace("]", "")) > LINE_MAX for x in lines):
            raise CueError(f"cue {i}: a line is longer than {LINE_MAX} characters")
        prev_end = e


def render(lines: list[str], path: str, font_path: str) -> None:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    font = ImageFont.truetype(font_path, FONT_SIZE, index=DEMI_BOLD_INDEX if font_path.endswith(".ttc") else 0)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd, d = ImageDraw.Draw(shadow), ImageDraw.Draw(img)
    ys = [H - 84] if len(lines) == 1 else [H - 150, H - 84]
    for line, y in zip(lines, ys):
        rs = runs(line)
        x = (W - sum(d.textlength(t, font=font) for t, _ in rs)) / 2
        for t, kw in rs:
            sd.text((x, y + 2), t, font=font, fill=(0, 0, 0, 235), anchor="ls", stroke_width=4, stroke_fill=(0, 0, 0, 235))
            d.text((x, y), t, font=font, fill=YELLOW if kw else WHITE, anchor="ls")
            x += d.textlength(t, font=font)
    out = shadow.filter(ImageFilter.GaussianBlur(5))
    out.alpha_composite(img)
    out.save(path)


def ffmpeg_args(src: str, out: str, pngs: list[str], cues: list[dict]) -> list[str]:
    inputs, chain, last = [], "", "0:v"
    for i, (p, c) in enumerate(zip(pngs, cues)):
        inputs += ["-i", p]
        # half-open [start, end): between() is inclusive at both ends, so back-to-back cues would share a frame
        chain += f"[{last}][{i + 1}:v]overlay=0:0:enable='gte(t,{c['start']})*lt(t,{c['end']})'[v{i}];"
        last = f"v{i}"
    return ["ffmpeg", "-v", "error", "-y", "-i", src, *inputs, "-filter_complex", chain.rstrip(";"),
            "-map", f"[{last}]", "-map", "0:a", "-c:v", "libx264", "-crf", "17", "-preset", "medium",
            "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cues", required=True)
    ap.add_argument("--input")
    ap.add_argument("--output")
    ap.add_argument("--font", default=DEFAULT_FONT)
    ap.add_argument("--check", action="store_true", help="validate cues and font only")
    a = ap.parse_args(argv)
    with open(a.cues, encoding="utf-8") as f:
        cues = json.load(f)["cues"]
    validate(cues)
    if not os.path.exists(a.font):
        raise CueError(f"font not found: {a.font} (pass --font)")
    if a.check:
        print(json.dumps({"ok": True, "cues": len(cues)}))
        return 0
    if not a.input or not a.output:
        raise CueError("--input and --output are required unless --check")
    if not has_audio(a.input):
        raise CueError(f"input has no audio stream: {a.input} - the lip-synced English cut must carry the English dub; "
                       "put the dub track back on it (export with audio) and burn again")
    with tempfile.TemporaryDirectory() as tmp:
        pngs = [os.path.join(tmp, f"cue{i:03d}.png") for i in range(len(cues))]
        for p, c in zip(pngs, cues):
            render(c["lines"], p, a.font)
        subprocess.check_call(ffmpeg_args(a.input, a.output, pngs, cues))
    print(json.dumps({"ok": True, "output": a.output, "cues": len(cues)}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (CueError, subprocess.CalledProcessError) as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
