import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('assembly_audit', ROOT/'scripts/audit_workflow.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        # Synthetic evidence, not a real editor acceptance.
        (root/'fixture').write_text('synthetic evidence')
        self.record = json.loads((ROOT/'assets/assembly-record.json').read_text())
        self.record.update(project_root=str(root), plan_evidence_path='fixture', approved_shot_ids=['A','B'])
        self.record['timeline'].update(project_id='project',timeline_id='timeline', timeline_revision='revision',
            duration_frames=300,snapshot_path='fixture',srt_path='fixture',srt_sha256='synthetic-hash')
        self.record['shots'] = [dict(shot_id=x, media_kind='deterministic_video', source_path='fixture',
            source_sha256='synthetic-hash', placements=[dict(asset_id=x,item_id=x,start_frame=i*100,
            end_frame=(i+1)*100,verified=True,evidence_path='fixture')]) for i,x in enumerate(['A','B'])]
        for item in self.record['checks'].values():
            item.update(status='verified',evidence_path='fixture')

    def test_complete_ledger_can_reach_review_but_is_not_approval(self):
        result = audit.assembly(self.record)
        self.assertTrue(result['ready_for_gate3'])
        self.assertNotIn('approved', result)

    def test_imported_assets_without_placements_are_incomplete(self):
        for shot in self.record['shots']:
            shot.update(imported=True,placements=[])
        result = audit.assembly(self.record)
        self.assertFalse(result['ready_for_gate3'])
        self.assertIn('shot.B.placements',result['missing'])

    def test_omitted_shot_and_missing_audio_are_reported_together(self):
        self.record['shots'].pop()
        self.record['checks']['bgm'] = dict(status='pending')
        self.record['checks']['mix'] = dict(status='pending')
        result = audit.assembly(self.record)
        for value in ['shot.B.placements','checks.bgm','checks.mix']:
            self.assertIn(value,result['missing'])

    def test_out_of_range_and_duplicate_item_are_rejected(self):
        self.record['shots'][1]['placements'][0].update(end_frame=400,item_id='A')
        result = audit.assembly(self.record)
        self.assertIn('shot.B.placements[0].range',result['missing'])
        self.assertIn('shot.B.placements[0].duplicate_item_id',result['missing'])

    def test_missing_or_external_evidence_does_not_pass(self):
        self.record['checks']['mix']['evidence_path'] = '../outside.json'
        self.record['checks']['sfx']['evidence_path'] = 'missing.json'
        result = audit.assembly(self.record)
        self.assertIn('checks.mix',result['missing'])
        self.assertIn('checks.sfx',result['missing'])

    def test_no_music_requires_user_scope_but_straight_cuts_are_editorial(self):
        for name in ['bgm','transitions']:
            self.record['checks'][name].update(status='not_applicable',reason='documented choice')
        self.assertIn('checks.bgm',audit.assembly(self.record)['missing'])
        self.assertNotIn('checks.transitions',audit.assembly(self.record)['missing'])
        self.record['checks']['bgm']['user_scope_evidence_path']='fixture'
        self.assertTrue(audit.assembly(self.record)['ready_for_gate3'])
        self.record['checks']['continuous_playback'].update(status='not_applicable',reason='no tool')
        self.assertFalse(audit.assembly(self.record)['ready_for_gate3'])

    def test_shown_gate_cannot_hide_unfinished_assembly(self):
        state = json.loads((ROOT/'assets/workflow-state.json').read_text())
        state.update(project_id='project',project_root=self.record['project_root'],phase='finish')
        for name in ['gate1','gate2']:
            state['gates'][name].update(status='approved',artifact_sha256='h',approved_sha256='h',
                user_message='通过',shown_at='observed',approved_at='observed')
        state['gates']['gate3']['status']='shown'
        self.assertEqual(audit.resume(state)['action'],'reconcile_assembly')
        state['assembly']=copy.deepcopy(self.record)
        state['assembly']['shots'][0]['placements']=[]
        self.assertEqual(audit.resume(state)['action'],'complete_assembly')
        state['assembly']=self.record
        self.assertEqual(audit.resume(state)['action'],'await_user_review')


if __name__ == '__main__':
    unittest.main()
