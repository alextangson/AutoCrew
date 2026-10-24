"""Run: uv run --project sidecars/captions python -m unittest discover -s sidecars/captions"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import burn_captions as b  # noqa: E402


class Validate(unittest.TestCase):
    def test_runs_mark_keyword(self):
        self.assertEqual(b.runs("I believe [the opposite]:"), [("I believe ", False), ("the opposite", True), (":", False)])

    def test_rejects_three_lines_two_keywords_overlap_long_line(self):
        for cues in (
            [{"start": 0, "end": 1, "lines": ["a", "b", "c"]}],
            [{"start": 0, "end": 1, "lines": ["[a] and [b]"]}],
            [{"start": 0, "end": 2, "lines": ["a"]}, {"start": 1, "end": 3, "lines": ["b"]}],
            [{"start": 0, "end": 1, "lines": ["x" * 43]}],
            [{"start": 1, "end": 1, "lines": ["a"]}],
        ):
            with self.assertRaises(b.CueError):
                b.validate(cues)

    def test_accepts_style_a(self):
        b.validate([{"start": 0, "end": 1.2, "lines": ["Be honest."]}, {"start": 1.3, "end": 4, "lines": ["The harder the task,", "the more you want [max effort]."]}])

    def test_keyword_wrapped_across_the_line_break_counts_once(self):
        b.validate([{"start": 0, "end": 2, "lines": ["The harder the task, the more you want [max]", "[effort] on it."]}])
        with self.assertRaises(b.CueError):
            b.validate([{"start": 0, "end": 2, "lines": ["[a] then", "[b] again"]}])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe") and os.path.exists(b.DEFAULT_FONT), "ffmpeg / font missing")
    def test_input_without_audio_fails_with_a_clear_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, cues = os.path.join(tmp, "silent.mp4"), os.path.join(tmp, "c.json")
            subprocess.check_call(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1", "-y", src])
            with open(cues, "w") as f:
                json.dump({"cues": [{"start": 0, "end": 0.5, "lines": ["hi"]}]}, f)
            r = subprocess.run([sys.executable, b.__file__, "--cues", cues, "--input", src, "--output", os.path.join(tmp, "o.mp4")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("no audio stream", r.stdout)

    def test_ffmpeg_chain_enables_each_cue_in_its_window(self):
        args = b.ffmpeg_args("in.mp4", "out.mp4", ["a.png", "b.png"], [{"start": 0, "end": 1}, {"start": 1.5, "end": 2}])
        chain = args[args.index("-filter_complex") + 1]
        self.assertIn("[0:v][1:v]overlay=0:0:enable='gte(t,0)*lt(t,1)'[v0]", chain)
        self.assertIn("[v0][2:v]overlay=0:0:enable='gte(t,1.5)*lt(t,2)'[v1]", chain)
        self.assertNotIn("between(", chain)  # back-to-back cues must not both show on the boundary frame
        self.assertEqual(args[args.index("-map") + 1], "[v1]")

    def test_check_mode_fails_visibly_on_missing_font(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "c.json")
            with open(p, "w") as f:
                json.dump({"cues": [{"start": 0, "end": 1, "lines": ["hi"]}]}, f)
            r = subprocess.run([sys.executable, b.__file__, "--cues", p, "--check", "--font", "/nope.ttf"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("font not found", r.stdout)

    @unittest.skipUnless(os.path.exists(b.DEFAULT_FONT), "macOS Avenir Next not installed")
    def test_render_png(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "c.png")
            b.render(["The harder the task,", "the more you want [max effort]."], out, b.DEFAULT_FONT)
            from PIL import Image
            img = Image.open(out)
            self.assertEqual(img.size, (1920, 1080))
            self.assertGreater(img.getbbox()[1], 800)  # bottom of the frame only


if __name__ == "__main__":
    unittest.main()
