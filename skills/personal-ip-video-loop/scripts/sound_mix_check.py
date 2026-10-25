#!/usr/bin/env python3
"""Measure a rendered narration mix: music-vs-voice gap, dead air, thin music, level jumps, loud SFX.

The music-under-voice gap is judged on ONE ruler: short-term LUFS (EBU R128 S, 3 s window,
ffmpeg ebur128) of each stem, voice minus music. Target 12 LU, every stretch within 10.5-13.5.
RMS is used only for sub-second checks (spikes, dead air, loud hits) and SFX.

Usage:
  sound_mix_check.py MIX.wav --stems DIR            # DIR holds vocals.wav + no_vocals.wav
  sound_mix_check.py MIX.wav --demucs-python PY     # separate first with demucs (htdemucs)
  add --sfx SFX.json to judge each sound effect against the voice around it:
    [{"at_s": 20.5, "file": "/abs/slide.mp3", "gain_db": -31.7, "dur_s": 1.2, "kind": "punch"}, ...]
    kind: "sfx" (default) | "punch" (comedic sting) | "accent" (key-line hit)
Writes a JSON report to stdout (or --out). Numbers are measurements, not listening.
"""
import argparse
import json
import math
import pathlib
import subprocess
import sys
import wave

import numpy as np

SILENT_DB = -60.0      # music below this counts as "no music"
MAX_GAP_S = 2.5        # longer music gaps under speech read as dead air (user, 2026-09-29)
MAX_JUMP_DB = 6.0      # sustained rise that reads as "suddenly louder" (drops are fine)
# Voice minus music in short-term LUFS (LU). One metric, one number: 12 LU (founder, 2026-09-29).
# RMS used to judge this and disagreed with LUFS on bass-light timbres; two rulers swung mixes.
GAP_TARGET_LU = 12.0
GAP_BAND_LU = (10.5, 13.5)
THIN_OVER_LU = 2.0      # stretches > band top + this read as "music gone"
LOUD_UNDER_LU = 1.0     # stretches < band bottom - this read as "music too loud"
VOICE_ACTIVE_LUFS = -40.0
MUSIC_PRESENT_LUFS = -60.0
LUFS_HOP_S = 0.1        # ebur128 reports S every 100 ms
# SFX mean loudness must sit this far under the voice's mean loudness in the 2 s around it.
# Peak-based gains still let dense sounds (slide whistle, booms, paper) read loud (user, 2026-09-29).
SFX_UNDER_VOICE_DB = {"sfx": 12.0, "punch": 10.0, "accent": 9.0}
SFX_TOLERANCE_DB = 1.0  # measurement noise; within this of the margin passes


def read_mono(path):
    with wave.open(str(path), "rb") as w:
        n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    dtype = {2: np.int16, 4: np.int32}[sw]
    x = np.frombuffer(raw, dtype=dtype).astype(np.float64) / float(np.iinfo(dtype).max)
    return x.reshape(-1, ch).mean(axis=1), sr


def window_db(x, sr, win_s, stat="rms"):
    hop = max(1, int(sr * win_s))
    n = len(x) // hop
    blocks = x[: n * hop].reshape(n, hop)
    v = np.sqrt((blocks ** 2).mean(axis=1)) if stat == "rms" else np.abs(blocks).max(axis=1)
    return 20 * np.log10(v + 1e-12)


def short_term_lufs(path):
    """Short-term LUFS (3 s window) every 100 ms, from ffmpeg's ebur128 filter."""
    out = subprocess.run(["ffmpeg", "-nostats", "-v", "error", "-i", str(path), "-af",
                          "ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.S:file=-",
                          "-f", "null", "-"], check=True, capture_output=True, text=True).stdout
    vals = [float(line.split("=", 1)[1]) for line in out.splitlines() if line.startswith("lavfi.r128.S=")]
    return np.array(vals, dtype=np.float64)


def gap_windows(voice_lufs, music_lufs):
    """Voice minus music (LU) per window; NaN where the voice is silent or music is absent."""
    n = min(len(voice_lufs), len(music_lufs))
    v, mu = voice_lufs[:n], music_lufs[:n]
    ok = (v > VOICE_ACTIVE_LUFS) & (mu > MUSIC_PRESENT_LUFS)
    return np.where(ok, v - mu, np.nan)


def voice_music_gap(gaps):
    valid = gaps[~np.isnan(gaps)]
    return float(np.median(valid)) if len(valid) else None


def gap_sections(gaps, hop_s=LUFS_HOP_S, section_s=10.0):
    """Median gap per fixed section, so one hot or thin stretch can't hide in the film-wide number."""
    k = max(1, int(round(section_s / hop_s)))
    out = []
    for i in range(0, len(gaps), k):
        seg = gaps[i:i + k]
        valid = seg[~np.isnan(seg)]
        if len(valid) >= len(seg) / 2:
            med = float(np.median(valid))
            out.append({"start_s": round(i * hop_s, 1), "end_s": round((i + len(seg)) * hop_s, 1),
                        "gap_lu": round(med, 1), "in_band": GAP_BAND_LU[0] <= med <= GAP_BAND_LU[1]})
    return out


def gap_runs(gaps, hop_s, predicate, min_s=5.0, span_s=1.0):
    """Stretches >= min_s whose 1 s median gap satisfies predicate."""
    k = max(1, int(round(span_s / hop_s)))
    n = len(gaps) // k
    if n == 0:
        return []
    blocks = gaps[: n * k].reshape(n, k)
    med = np.array([np.median(b[~np.isnan(b)]) if (~np.isnan(b)).sum() >= k / 2 else np.nan for b in blocks])
    hit = np.array([not np.isnan(x) and predicate(x) for x in med])
    out, start = [], None
    for i, t in enumerate(list(hit) + [False]):
        if t and start is None:
            start = i
        elif not t and start is not None:
            if (i - start) * span_s >= min_s:
                out.append({"start_s": round(start * span_s, 1), "end_s": round(i * span_s, 1),
                            "voice_minus_music_lu": round(float(np.median(med[start:i])), 1)})
            start = None
    return out


def thin_music(gaps, hop_s=LUFS_HOP_S):
    """Music present but too far under the voice to be heard (reads as dead air)."""
    return gap_runs(gaps, hop_s, lambda g: g > GAP_BAND_LU[1] + THIN_OVER_LU)


def too_loud_music(gaps, hop_s=LUFS_HOP_S):
    """Music crowding the voice."""
    return gap_runs(gaps, hop_s, lambda g: g < GAP_BAND_LU[0] - LOUD_UNDER_LU)


def dead_air(music_db, voice_db, win_s, max_gap_s=MAX_GAP_S):
    """Runs where music is absent while the programme continues (not the first/last second)."""
    out, start = [], None
    quiet = music_db < SILENT_DB
    for i, q in enumerate(list(quiet) + [False]):
        if q and start is None:
            start = i
        elif not q and start is not None:
            s, e = start * win_s, i * win_s
            talking = voice_db[start:i].max() > -40 if i > start else False
            if e - s > max_gap_s and s > 1.0 and i < len(quiet) - 1 / win_s and talking:
                out.append({"start_s": round(s, 1), "end_s": round(e, 1), "seconds": round(e - s, 1)})
            start = None
    return out


def level_jumps(music_db, win_s, max_jump_db=MAX_JUMP_DB, span_s=4.0, context_s=30.0, above_norm_db=2.0):
    """Sustained rises that also land above the recent norm.

    A rise out of an intended dip back to the usual bed level is fine; a rise that
    ends louder than the previous ~30 s of bed is what reads as "suddenly louder".
    """
    k, c = max(1, int(span_s / win_s)), max(1, int(context_s / win_s))
    out, last = [], -1e9
    for i in range(k, len(music_db) - k):
        a, b = np.median(music_db[i - k:i]), np.median(music_db[i:i + k])
        ctx = music_db[max(0, i - c):i]
        ctx = ctx[ctx > SILENT_DB]
        norm = float(np.median(ctx)) if len(ctx) else a
        if (a > SILENT_DB and b > SILENT_DB and b - a > max_jump_db and b - norm > above_norm_db
                and i * win_s - last > span_s):
            out.append({"at_s": round(i * win_s, 1), "from_db": round(float(a), 1),
                        "to_db": round(float(b), 1), "recent_norm_db": round(norm, 1)})
            last = i * win_s
    return out


def loud_hits(music_peak_db, voice_peak_db, win_s, margin_db=0.0):
    """Music-stem peaks (SFX, stingers) louder than the voice's own 95th-percentile peak."""
    ref = float(np.percentile(voice_peak_db[voice_peak_db > -50], 95)) if (voice_peak_db > -50).any() else -12.0
    idx = np.where(music_peak_db > ref + margin_db)[0]
    hits, last = [], -1.0
    for i in idx:
        t = i * win_s
        if t - last > 0.5:
            hits.append({"at_s": round(t, 2), "peak_db": round(float(music_peak_db[i]), 1)})
            last = t
    return ref, hits


def music_spikes(voice_db, music_db, win_s, context_s=8.0, rise_db=6.0, min_gap_db=6.0, sfx_at_s=()):
    """Short music bursts that reach the voice: intro swells, a beat dropping back in after a break.

    level_jumps uses 4 s medians and averages ~1 s bursts away; the 2026-09-29 review found two
    that way (music within 3 dB of the voice) after the script had passed the mix.
    The music stem also carries the SFX; windows from 0.25 s before to 1.5 s after a placed
    effect (sfx_at_s) are left to the SFX check.
    """
    c = max(1, int(context_s / win_s))
    out, last = [], -1e9
    for i in range(len(music_db)):
        if any(-0.25 <= i * win_s - t <= 1.5 for t in sfx_at_s):
            continue
        # silence counts at the floor, so a lone burst out of silence is judged against it
        norm = float(np.median(np.maximum(music_db[max(0, i - c):i + c + 1], SILENT_DB)))
        talking = voice_db[i] > -40
        if (talking and music_db[i] - norm > rise_db and voice_db[i] - music_db[i] < min_gap_db
                and i * win_s - last > 1.0):
            out.append({"at_s": round(i * win_s, 1), "music_db": round(float(music_db[i]), 1),
                        "local_norm_db": round(norm, 1),
                        "voice_minus_music_db": round(float(voice_db[i] - music_db[i]), 1)})
            last = i * win_s
    return out


def sfx_too_loud(sfx_db, voice_db, kind="sfx"):
    """Required margin for this kind of effect, or None when it sits quietly enough."""
    need = SFX_UNDER_VOICE_DB.get(kind, SFX_UNDER_VOICE_DB["sfx"])
    return need if voice_db - sfx_db < need - SFX_TOLERANCE_DB else None


def source_mean_db(path, dur_s):
    # Decode at the file's own channel count and average here: ffmpeg's "-ac 1" downmix
    # sums stereo at -3 dB per channel, which reads identical channels 3 dB hot.
    ch = int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                             "stream=channels", "-of", "csv=p=0", str(path)],
                            check=True, capture_output=True, text=True).stdout.split()[0])
    raw = subprocess.run(["ffmpeg", "-v", "error", "-t", str(dur_s), "-i", str(path),
                          "-f", "f32le", "-"], check=True, capture_output=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    x = x[: len(x) // ch * ch]  # power-average across channels so anti-phase stereo cannot cancel
    return 20 * math.log10(math.sqrt(float((x ** 2).mean())) + 1e-12) if len(x) else SILENT_DB


def sfx_report(sfx, voice, sr):
    out = []
    for e in sfx:
        s_db = source_mean_db(e["file"], e["dur_s"]) + e.get("gain_db", 0.0)
        a, b = max(0, int((e["at_s"] - 2) * sr)), int((e["at_s"] + 2) * sr)
        seg = voice[a:b]
        v_db = 20 * math.log10(math.sqrt(float((seg ** 2).mean())) + 1e-12) if len(seg) else SILENT_DB
        kind = e.get("kind", "sfx")
        need = sfx_too_loud(s_db, v_db, kind)
        if need is not None:
            out.append({"at_s": e["at_s"], "file": pathlib.Path(e["file"]).name, "kind": kind,
                        "sfx_db": round(s_db, 1), "voice_db": round(v_db, 1),
                        "under_voice_db": round(v_db - s_db, 1), "need_db": need,
                        "suggest_gain_change_db": round(v_db - s_db - need, 1)})
    return out


def separate(mix, py):
    outdir = mix.parent / "sep"
    subprocess.run([py, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(outdir), str(mix)],
                   check=True, capture_output=True)
    return outdir / "htdemucs" / mix.stem


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("mix", type=pathlib.Path)
    ap.add_argument("--stems", type=pathlib.Path)
    ap.add_argument("--demucs-python")
    ap.add_argument("--out", type=pathlib.Path)
    ap.add_argument("--sfx", type=pathlib.Path, help="JSON list of placed sound effects (see top)")
    a = ap.parse_args(argv)
    stems = a.stems or (separate(a.mix, a.demucs_python) if a.demucs_python else None)
    if stems is None:
        sys.exit("need --stems or --demucs-python")
    voice, sr = read_mono(stems / "vocals.wav")
    music, _ = read_mono(stems / "no_vocals.wav")
    v5, m5 = window_db(voice, sr, 0.5), window_db(music, sr, 0.5)
    v01, m01 = window_db(voice, sr, 0.1), window_db(music, sr, 0.1)
    sfx = json.loads(a.sfx.read_text()) if a.sfx else None
    ref, hits = loud_hits(window_db(music, sr, 0.05, "peak"), window_db(voice, sr, 0.05, "peak"), 0.05)
    gaps = gap_windows(short_term_lufs(stems / "vocals.wav"), short_term_lufs(stems / "no_vocals.wav"))
    gap = voice_music_gap(gaps)
    report = {
        "gap_metric": "short-term LUFS (EBU R128 S, 3 s), voice minus music, median",
        "voice_minus_music_lu": None if gap is None else round(gap, 1),
        "target_lu": GAP_TARGET_LU, "band_lu": list(GAP_BAND_LU),
        "ratio_ok": gap is not None and GAP_BAND_LU[0] <= gap <= GAP_BAND_LU[1],
        "gap_sections": gap_sections(gaps),
        "thin_music": thin_music(gaps),
        "too_loud_music": too_loud_music(gaps),
        "dead_air": dead_air(m01, v01, 0.1),
        "level_jumps": level_jumps(m5, 0.5),
        "music_spikes": music_spikes(v5, m5, 0.5, sfx_at_s=[e["at_s"] for e in sfx or []]),
        "voice_peak_ref_db": round(ref, 1),
        "loud_hits": hits,
        "sfx_too_loud": sfx_report(sfx, voice, sr) if sfx else None,
        "note": ("Measured, not heard. level_jumps also fire on intended cue entries; judge each against the "
                 "cue sheet. loud_hits is peak-only and demucs splits short SFX between stems: pass --sfx."),
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    (a.out.write_text(text) if a.out else print(text))


if __name__ == "__main__":
    main()
