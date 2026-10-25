import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('profile_check', Path(__file__).parents[1] / 'scripts/verify_production_profile.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write('autocrew-library.json', {'id': 'library-fixture'})
        self.write('workspaces/default/project-layout.json', {'library_id': 'library-fixture', 'workspace_id': 'default'})
        self.package = self.root / 'shared-assets/profile/v1'
        self.package.mkdir(parents=True)
        (self.package / 'rules.md').write_text('fixture rules')
        self.manifest = {'schema_version': 1, 'profile_id': 'fixture-v1', 'rules': 'rules.md',
                         'entrypoint': 'rules.md', 'visual_lock': 'rules.md', 'files': [
            {'path': 'rules.md', 'bytes': 13, 'sha256': hashlib.sha256(b'fixture rules').hexdigest()}]}
        self.adoption = {'schema_version': 1, 'library_id': 'library-fixture', 'workspace_id': 'default',
                         'profile_id': 'fixture-v1', 'manifest_path': 'shared-assets/profile/v1/manifest.json'}
        self.seal()

    def write(self, name, value):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value))
        return file

    def seal(self):
        manifest = self.write(self.adoption['manifest_path'], self.manifest)
        self.adoption['manifest_sha256'] = module.digest(manifest)
        self.adoption_file = self.write('workspaces/default/production/adopted-profile.json', self.adoption)

    def test_valid_and_portable_package(self):
        self.assertEqual(module.verify(self.root, self.adoption_file)['files_verified'], 1)
        relocated = self.root / 'relocated'
        import shutil
        shutil.copytree(self.root / 'shared-assets', relocated / 'shared-assets')
        shutil.copytree(self.root / 'workspaces', relocated / 'workspaces')
        shutil.copyfile(self.root / 'autocrew-library.json', relocated / 'autocrew-library.json')
        self.assertTrue(module.verify(relocated, relocated / 'workspaces/default/production/adopted-profile.json')['ok'])

    def test_modified_file_rejected(self):
        (self.package / 'rules.md').write_text('changed rules')
        with self.assertRaisesRegex(ValueError, 'file hash mismatch'):
            module.verify(self.root, self.adoption_file)

    def test_manifest_tampering_rejected(self):
        (self.package / 'manifest.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'manifest hash mismatch'):
            module.verify(self.root, self.adoption_file)

    def test_unlisted_file_rejected(self):
        (self.package / 'extra.md').write_text('not frozen')
        with self.assertRaisesRegex(ValueError, 'unlisted'):
            module.verify(self.root, self.adoption_file)

    def test_symlink_rejected(self):
        (self.package / 'rules.md').unlink()
        (self.package / 'rules.md').symlink_to(self.root / 'autocrew-library.json')
        with self.assertRaisesRegex(ValueError, 'symbolic links'):
            module.verify(self.root, self.adoption_file)

    def test_traversal_rejected(self):
        self.manifest['files'][0]['path'] = '../outside.md'
        self.seal()
        with self.assertRaisesRegex(ValueError, 'inside package'):
            module.verify(self.root, self.adoption_file)

    def test_wrong_identity_rejected(self):
        self.adoption['library_id'] = 'another-library'
        self.seal()
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            module.verify(self.root, self.adoption_file)

    def test_pinned_project_survives_new_default(self):
        pinned = self.write('project/production-adoption.json', self.adoption)
        changed = {**self.adoption, 'profile_id': 'not-this-version'}
        self.write('workspaces/default/production/adopted-profile.json', changed)
        self.assertTrue(module.verify(self.root, pinned)['ok'])
        with self.assertRaisesRegex(ValueError, 'profile identity mismatch'):
            module.verify(self.root, self.adoption_file)


if __name__ == '__main__':
    unittest.main()
