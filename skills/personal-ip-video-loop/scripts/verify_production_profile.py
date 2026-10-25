#!/usr/bin/env python3
"""Read-only verification of a workspace's pinned editing package."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inside(root, relative):
    if not isinstance(relative, str) or not relative or '\\' in relative:
        raise ValueError('invalid relative path')
    parts = relative.split('/')
    if PurePosixPath(relative).is_absolute() or any(p in ('', '.', '..') for p in parts):
        raise ValueError('path must stay inside package')
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('symbolic links are not package files')
    if not current.is_file():
        raise ValueError(f'missing file: {relative}')
    return current


def verify(library, adoption_file):
    library = Path(library).resolve(strict=True)
    adoption_file = Path(adoption_file)
    adoption = json.loads(adoption_file.read_text())
    marker = json.loads((library / 'autocrew-library.json').read_text())
    if adoption.get('schema_version') != 1 or adoption.get('library_id') != marker['id']:
        raise ValueError('adoption library identity mismatch')
    workspace = adoption.get('workspace_id', '')
    layout_file = inside(library, f'workspaces/{workspace}/project-layout.json')
    layout = json.loads(layout_file.read_text())
    if layout.get('workspace_id') != workspace or layout.get('library_id') != marker['id']:
        raise ValueError('adoption workspace identity mismatch')
    manifest_file = inside(library, adoption['manifest_path'])
    if not adoption['manifest_path'].startswith('shared-assets/'):
        raise ValueError('package must be in shared-assets')
    if digest(manifest_file) != adoption['manifest_sha256']:
        raise ValueError('package manifest hash mismatch')
    manifest = json.loads(manifest_file.read_text())
    if manifest.get('schema_version') != 1 or manifest.get('profile_id') != adoption['profile_id']:
        raise ValueError('profile identity mismatch')
    root = manifest_file.parent
    entries = manifest['files']
    seen = set()
    for entry in entries:
        name = entry['path']
        if name in seen:
            raise ValueError('duplicate package path')
        seen.add(name)
        file = inside(root, name)
        if file.stat().st_size != entry['bytes'] or digest(file) != entry['sha256']:
            raise ValueError(f'package file hash mismatch: {name}')
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p != manifest_file}
    if actual != seen or any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('unlisted package files or links')
    for key in ('rules', 'entrypoint', 'visual_lock'):
        if manifest[key] not in seen:
            raise ValueError(f'unlisted entry: {key}')
    return {'ok': True, 'profile_id': adoption['profile_id'], 'files_verified': len(entries),
            'manifest_sha256': adoption['manifest_sha256'],
            **{key: str(inside(root, manifest[key])) for key in ('rules', 'entrypoint', 'visual_lock')}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', required=True)
    parser.add_argument('--adoption', required=True)
    args = parser.parse_args()
    try:
        result = verify(args.library, args.adoption)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
