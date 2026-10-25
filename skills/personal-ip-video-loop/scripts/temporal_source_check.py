#!/usr/bin/env python3
"""Read-only candidate detection for opaque full-frame source/export comparison."""
import argparse
import hashlib
import json
import subprocess
from fractions import Fraction
from pathlib import Path
import numpy as np


def decode(path):
    result = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path),
        '-vf', 'scale=160:90', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        capture_output=True, check=True)
    if result.stderr:
        raise RuntimeError(result.stderr.decode(errors='replace'))
    return np.frombuffer(result.stdout, np.uint8).reshape(-1, 90, 160, 3)


def probe(path):
    result = subprocess.check_output(['ffprobe', '-v', 'error',
        '-select_streams', 'v:0', '-show_entries',
        'stream=r_frame_rate,avg_frame_rate', '-of', 'json', str(path)])
    stream = json.loads(result)['streams'][0]
    rate = Fraction(stream['r_frame_rate'])
    if rate != Fraction(stream['avg_frame_rate']):
        raise ValueError('VFR requires explicit PTS mapping: ' + str(path))
    return float(rate)


def find_candidates(export, source, start, duration, source_in, fps, source_fps,
                    rate=1, threshold=35, crop_rows=65):
    """Allow +/-1 source frame for sampling phase; flag large visual mismatch."""
    if start < 0 or duration <= 0 or start + duration > len(export):
        raise ValueError('Timeline range exceeds decoded export')
    if source_in < 0 or fps <= 0 or source_fps <= 0 or rate <= 0:
        raise ValueError('Invalid source mapping')
    candidates = []
    for f in range(start, start + duration):
        center = round((source_in + (f-start)/fps*rate)*source_fps)
        matches = [float(np.abs(export[f, :crop_rows].astype(np.float32)
                     - source[k, :crop_rows].astype(np.float32)).mean())
                   for k in range(max(0, center-1), min(len(source), center+2))]
        if not matches or min(matches) > threshold:
            candidates.append({'frame': f, 'seconds': round(f/fps, 6),
                'sourceFrame': center, 'distance': min(matches) if matches else None})
    return candidates


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('export'); ap.add_argument('manifest'); ap.add_argument('output')
    ap.add_argument('--threshold', type=float, default=35)
    args = ap.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    frames = decode(args.export)
    fps = probe(args.export)
    if abs(fps-manifest['fps']) > 0.001:
        raise ValueError('Export and timeline frame rates differ')
    results = []
    for clip in manifest['clips']:
        source = decode(clip['path'])
        candidates = find_candidates(frames, source, clip['startFrame'],
            clip['durationFrames'], clip.get('sourceInUs', 0)/1e6, fps,
            probe(clip['path']), clip.get('playbackRate', 1), args.threshold)
        if candidates:
            results.append({'name': clip['name'], 'path': clip['path'],
                            'candidates': candidates})
    with open(args.export, 'rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    report = {'export': args.export, 'sha256': digest, 'frames': len(frames),
        'fps': fps, 'checkedClips': len(manifest['clips']), 'threshold': args.threshold,
        'candidateCount': sum(len(r['candidates']) for r in results),
        'status': 'candidates_require_review' if results else 'no_large_source_mismatch_detected',
        'limits': 'Opaque full-frame equivalent geometry only; top 65/90 rows; +/-1 source-frame tolerance. Not normal-speed review, freeze detection or creative acceptance.',
        'results': results}
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k:v for k,v in report.items() if k != 'results'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
