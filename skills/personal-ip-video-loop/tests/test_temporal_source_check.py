import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('temporal',
    Path(__file__).resolve().parents[1] / 'scripts/temporal_source_check.py')
temporal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(temporal)


class TemporalCheckTests(unittest.TestCase):
    def test_flash_and_two_frame_tail_leak(self):
        source = np.full((10, 90, 160, 3), 70, dtype=np.uint8)
        export = source.copy()
        export[[3, 8, 9]] = 220
        found = temporal.find_candidates(export, source, 0, 10, 0, 30, 30)
        self.assertEqual([x['frame'] for x in found], [3, 8, 9])

    def test_intentional_hold_and_cut(self):
        a = np.full((5, 90, 160, 3), 70, dtype=np.uint8)
        b = np.full_like(a, 220)
        export = np.concatenate([a, b])
        self.assertEqual(temporal.find_candidates(export, a, 0, 5, 0, 30, 30), [])
        self.assertEqual(temporal.find_candidates(export, b, 5, 5, 0, 30, 30), [])

    def test_missing_export_range_is_not_clean(self):
        a = np.zeros((5, 90, 160, 3), dtype=np.uint8)
        with self.assertRaises(ValueError):
            temporal.find_candidates(a, a, 0, 6, 0, 30, 30)


if __name__ == '__main__':
    unittest.main()
