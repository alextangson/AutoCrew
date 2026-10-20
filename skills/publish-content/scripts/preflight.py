#!/usr/bin/env python3
"""Read-only local preparation and recovery check. Never authorizes publication."""
import argparse
import hashlib
import json
from pathlib import Path

TERMINAL_OR_SENT = {'published', 'submitted', 'reviewing', 'scheduled', 'submission_unknown', 'submitting'}

def inspect(plan):
    errors, rows = [], []
    if plan.get('example_only'):
        errors.append('Example plan is not an executable release')
    seen = set()
    for row in plan.get('platforms', []):
        platform = row.get('platform')
        if platform in seen:
            errors.append(f'{platform}: duplicate platform row')
        seen.add(platform)
        status = row.get('publication', {}).get('status', 'not_prepared')
        next_step = 'verify_receipt_only' if status in TERMINAL_OR_SENT else 'prepare_and_check'
        rows.append({'platform': platform, 'status': status, 'next_action': next_step})
        if status in TERMINAL_OR_SENT:
            continue  # A missing archived video must not trigger a re-upload.
        for key in ['account_display_name', 'account_public_profile', 'title', 'caption', 'timezone']:
            if not row.get(key): errors.append(f'{platform}: missing {key}')
        if not row.get('authorization'):
            errors.append(f'{platform}: missing authorization evidence; script cannot interpret consent')
        if not row.get('check_id'):
            errors.append(f'{platform}: missing check_id; resolve per publishing contract')
        if not row.get('scheduled_at') and row.get('publish_mode') != 'immediate':
            errors.append(f'{platform}: explicit immediate mode or scheduled_at required')
        if not row.get('covers'): errors.append(f'{platform}: missing covers')
        for cover in row.get('covers', []):
            f = Path(cover.get('path') or '')
            if not f.is_absolute() or not f.is_file(): errors.append(f'{platform}: cover file missing')
    if not rows: errors.append('No platforms')
    if any(r['next_action'] == 'prepare_and_check' for r in rows):
        video = plan.get('final_video', {})
        f = Path(video.get('path') or '')
        if not f.is_absolute() or not f.is_file(): errors.append('Final video missing')
        elif not video.get('sha256'): errors.append('Final video hash missing')
        else:
            h = hashlib.sha256()
            with f.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
            if h.hexdigest() != video['sha256']: errors.append('Final video hash mismatch')
        for cover in plan.get('approved_covers', []):
            f = Path(cover.get('path') or '')
            if not f.is_file(): errors.append('Approved cover missing')
            elif cover.get('sha256') and hashlib.sha256(f.read_bytes()).hexdigest() != cover['sha256']:
                errors.append('Approved cover hash mismatch')
    return {'ok': not errors, 'scope': 'local_only_not_publication_authorization', 'platforms': rows, 'errors': errors}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plan', type=Path)
    args = parser.parse_args()
    try:
        result = inspect(json.loads(args.plan.read_text()))
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        result = {'ok': False, 'errors': [str(exc)]}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ok'] else 1)
