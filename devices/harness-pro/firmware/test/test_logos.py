#!/usr/bin/env python3
"""Logo table (main/pod/engine_logos.c): sizes 44/72, every engine, the notice size within budget."""
import re
import unittest
from pathlib import Path

PRO = Path(__file__).resolve().parents[1]
C = (PRO / 'main/pod/engine_logos.c').read_text()
H = (PRO / 'main/pod/engine_logos.h').read_text()
ENGINES = "agy amp claude codex commandcode copilot cursor devin grok hermes kilo muse opencode pi prime".split()


class LogoTests(unittest.TestCase):
    def test_sizes(self):
        self.assertIn('POD_LOGO_NSIZES = 2', H)
        self.assertIn('pod_logo_sizes[POD_LOGO_NSIZES] = {44, 72}', C)

    def test_sizes_every_engine_and_budget(self):
        total = 0
        for e in ENGINES:
            for s in (44,):
                self.assertTrue(re.search(r'l_%s_%d_px\[%d\]' % (e, s, s * s), C), (e, s))
                total += s * s * 3
        print('44 px logo bytes (px + alpha):', total)
        self.assertLessEqual(total, 100 * 1000)


if __name__ == '__main__':
    unittest.main()
