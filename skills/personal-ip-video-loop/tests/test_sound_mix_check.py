import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('smc', Path(__file__).parents[1] / 'scripts/sound_mix_check.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

W = 0.5  # seconds per window


def bed(seconds, db):
    return np.full(int(seconds / W), float(db))


class DeadAirTests(unittest.TestCase):
    def test_long_music_gap_under_speech_is_flagged(self):
        music = np.concatenate([bed(20, -45), bed(22, -80), bed(20, -45)])
        voice = np.full(len(music), -30.0)
        gaps = m.dead_air(music, voice, W)
        self.assertEqual(len(gaps), 1)
        self.assertAlmostEqual(gaps[0]['seconds'], 22.0)

    def test_short_intended_stop_is_allowed(self):
        music = np.concatenate([bed(20, -45), bed(2, -80), bed(20, -45)])
        self.assertEqual(m.dead_air(music, np.full(len(music), -30.0), W), [])

    def test_gap_with_no_speech_is_not_dead_air(self):
        music = np.concatenate([bed(20, -45), bed(10, -80), bed(20, -45)])
        voice = np.concatenate([bed(20, -30), bed(10, -80), bed(20, -30)])
        self.assertEqual(m.dead_air(music, voice, W), [])


class JumpTests(unittest.TestCase):
    def test_ending_louder_than_recent_bed_is_flagged(self):
        # the 2026-09-29 case: tired dip at -52, then the ending bed comes in at -43
        music = np.concatenate([bed(40, -47), bed(12, -52), bed(30, -43)])
        jumps = m.level_jumps(music, W)
        self.assertEqual(len(jumps), 1)
        self.assertGreater(jumps[0]['to_db'], jumps[0]['recent_norm_db'])

    def test_return_from_intended_dip_is_not_flagged(self):
        music = np.concatenate([bed(40, -46), bed(8, -56), bed(30, -46)])
        self.assertEqual(m.level_jumps(music, W), [])

    def test_drops_are_not_flagged(self):
        music = np.concatenate([bed(40, -40), bed(30, -52)])
        self.assertEqual(m.level_jumps(music, W), [])


class HitAndRatioTests(unittest.TestCase):
    def test_sfx_louder_than_voice_peaks_is_flagged(self):
        voice_peaks = np.full(2000, -15.0)
        music_peaks = np.full(2000, -35.0); music_peaks[500] = -9.0
        ref, hits = m.loud_hits(music_peaks, voice_peaks, 0.05)
        self.assertAlmostEqual(ref, -15.0)
        self.assertEqual([h['at_s'] for h in hits], [25.0])

    def test_voice_music_gap_uses_only_shared_windows(self):
        voice = np.array([-24.0, -24.0, -80.0]); music = np.array([-36.0, -80.0, -38.0])
        gaps = m.gap_windows(voice, music)
        self.assertAlmostEqual(m.voice_music_gap(gaps), 12.0)


H = 0.1  # LUFS hop


def lu(seconds, v):
    return np.full(int(round(seconds / H)), float(v))


class LufsGapTests(unittest.TestCase):
    def test_gap_twenty_lu_under_for_long_is_thin(self):
        gaps = np.concatenate([lu(20, 12), lu(20, 18), lu(20, 12)])
        thin = m.thin_music(gaps)
        self.assertEqual([(t['start_s'], t['end_s']) for t in thin], [(20.0, 40.0)])
        self.assertEqual(m.too_loud_music(gaps), [])

    def test_music_crowding_voice_is_too_loud(self):
        gaps = np.concatenate([lu(20, 12), lu(8, 8.5), lu(20, 12)])
        loud = m.too_loud_music(gaps)
        self.assertEqual(len(loud), 1)
        self.assertAlmostEqual(loud[0]['voice_minus_music_lu'], 8.5)

    def test_approved_band_and_brief_excursions_pass(self):
        # 2026-09-29 approved mix: sections 12.1-13.8 LU; 3 s excursions don't count
        gaps = np.concatenate([lu(20, 12.1), lu(3, 17), lu(20, 13.8), lu(3, 8), lu(20, 12.5)])
        self.assertEqual(m.thin_music(gaps), [])
        self.assertEqual(m.too_loud_music(gaps), [])
        self.assertTrue(10.5 <= m.voice_music_gap(gaps) <= 13.5)

    def test_sections_report_each_out_of_band_stretch(self):
        gaps = np.concatenate([lu(10, 12), lu(10, 16), lu(10, 12)])
        secs = m.gap_sections(gaps)
        self.assertEqual([x['in_band'] for x in secs], [True, False, True])


class ShortTermLufsTests(unittest.TestCase):
    """Real ffmpeg measurement: the gap in LU follows the level offset between stems."""

    def _write(self, path, x, sr=48000):
        import wave
        with wave.open(str(path), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())

    def test_twelve_db_offset_reads_as_twelve_lu(self):
        import tempfile
        sr, t = 48000, 12
        rng = np.random.default_rng(0)
        voice = 0.1 * rng.standard_normal(sr * t)
        music = voice[::-1] * 10 ** (-12 / 20)  # same spectrum, 12 dB down
        with tempfile.TemporaryDirectory() as d:
            self._write(Path(d) / 'v.wav', voice); self._write(Path(d) / 'm.wav', music)
            gaps = m.gap_windows(m.short_term_lufs(Path(d) / 'v.wav'), m.short_term_lufs(Path(d) / 'm.wav'))
        self.assertAlmostEqual(m.voice_music_gap(gaps), 12.0, delta=0.3)

    def test_bass_tone_is_weighted_unlike_rms(self):
        # equal RMS, but K-weighting hears a 60 Hz tone quieter than a 1 kHz tone
        import tempfile
        sr, t = 48000, 8
        n = np.arange(sr * t) / sr
        with tempfile.TemporaryDirectory() as d:
            self._write(Path(d) / 'hi.wav', 0.1 * np.sin(2 * np.pi * 1000 * n))
            self._write(Path(d) / 'lo.wav', 0.1 * np.sin(2 * np.pi * 60 * n))
            hi = np.median(m.short_term_lufs(Path(d) / 'hi.wav')[40:])
            lo = np.median(m.short_term_lufs(Path(d) / 'lo.wav')[40:])
        self.assertGreater(hi - lo, 0.5)


class SpikeTests(unittest.TestCase):
    def test_one_second_swell_reaching_voice_is_flagged(self):
        # the 2026-09-29 review case: an intro swell ~12 dB over the bed, within 3 dB of the voice
        music = bed(30, -46); music[40:42] = -34.0
        voice = np.full(len(music), -32.0)
        spikes = m.music_spikes(voice, music, W)
        self.assertEqual([s['at_s'] for s in spikes], [20.0])
        self.assertEqual(m.level_jumps(music, W), [])  # the 4 s medians miss it

    def test_normal_beat_variation_passes(self):
        music = bed(30, -46); music[::4] = -43.0
        self.assertEqual(m.music_spikes(np.full(len(music), -32.0), music, W), [])

    def test_placed_sfx_is_left_to_the_sfx_check(self):
        music = bed(30, -46); music[40:42] = -34.0
        voice = np.full(len(music), -32.0)
        self.assertEqual(m.music_spikes(voice, music, W, sfx_at_s=[19.9]), [])

    def test_swell_between_sentences_passes(self):
        music = bed(30, -46); music[40:42] = -34.0
        voice = np.full(len(music), -32.0); voice[40:42] = -70.0
        self.assertEqual(m.music_spikes(voice, music, W), [])


    def test_burst_out_of_silence_is_flagged(self):
        music = np.full(60, -80.0); music[30:32] = -31.0
        self.assertEqual([x['at_s'] for x in m.music_spikes(np.full(60, -30.0), music, W)], [15.0])


class SfxLoudnessTests(unittest.TestCase):
    def test_dense_sting_with_quiet_peak_can_still_be_too_loud(self):
        # the 2026-09-29 slide whistle: peak -20 dBFS, but mean -29.8 against voice -31.7
        self.assertEqual(m.sfx_too_loud(-29.8, -31.7, 'punch'), 10.0)

    def test_margins_depend_on_kind(self):
        self.assertIsNone(m.sfx_too_loud(-44.0, -32.0, 'sfx'))
        self.assertEqual(m.sfx_too_loud(-40.5, -32.0, 'sfx'), 12.0)
        self.assertIsNone(m.sfx_too_loud(-43.2, -32.0, 'sfx'))  # within tolerance
        self.assertIsNone(m.sfx_too_loud(-42.0, -32.0, 'punch'))
        self.assertIsNone(m.sfx_too_loud(-41.0, -32.0, 'accent'))

    def test_unknown_kind_uses_default(self):
        self.assertEqual(m.sfx_too_loud(-40.0, -32.0, 'whatever'), 12.0)


class SourceLevelTests(unittest.TestCase):
    def test_anti_phase_stereo_does_not_cancel(self):
        from unittest.mock import patch
        import subprocess
        x = np.column_stack([np.full(1000, .1), np.full(1000, -.1)]).astype('float32')
        runs = [subprocess.CompletedProcess([], 0, stdout='2\n'), subprocess.CompletedProcess([], 0, stdout=x.tobytes())]
        with patch.object(m.subprocess, 'run', side_effect=runs):
            self.assertAlmostEqual(m.source_mean_db('sfx.wav', 1), -20.0, places=3)


class FineSilenceTests(unittest.TestCase):
    def test_three_second_gap_found_with_fine_windows(self):
        # 3.0 s under speech: over the 2.5 s limit (2026-09-29 review, missed at 0.5 s windows)
        w = 0.1
        music = np.concatenate([np.full(200, -45.0), np.full(30, -75.0), np.full(200, -45.0)])
        gaps = m.dead_air(music, np.full(len(music), -30.0), w)
        self.assertEqual(len(gaps), 1)
        self.assertAlmostEqual(gaps[0]['seconds'], 3.0)


if __name__ == '__main__':
    unittest.main()
