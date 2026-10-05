from pathlib import Path
import tempfile
import unittest

from browser_memory import snapshot


class BrowserMemory(unittest.TestCase):
    def test_snapshot_preserves_swapped_processes_pressure_and_compression(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = {
                'proc/meminfo': 'MemTotal: 1024 kB\nMemAvailable: 50 kB\nSwapFree: 1 kB\n',
                'proc/pressure/memory': 'full avg10=42.00 avg60=1.00 avg300=0.10 total=2500000\n',
                'proc/101/comm': 'opencode\n',
                'proc/101/cmdline': 'opencode\0serve\0--service\0',
                'proc/101/status': 'PPid:\t50\nVmRSS:\t3 kB\nVmSwap:\t800 kB\n',
                'proc/101/smaps_rollup': 'Rss: 3 kB\nPss: 2 kB\nSwap: 800 kB\nSwapPss: 700 kB\n',
                'sys/block/zram0/mm_stat': '800000 200000 250000 0 260000 0 0 0 0\n',
                'sys/block/zram0/comp_algorithm': 'lzo [zstd]\n',
                'sys/module/zswap/parameters/enabled': 'Y\n',
            }
            for name, value in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            result = snapshot(root / 'proc', root / 'sys')
            self.assertEqual(result['processes'][0]['smaps_rollup'], files['proc/101/smaps_rollup'])
            self.assertEqual(result['processes'][0]['cmdline'], 'opencode serve --service')
            self.assertEqual(result['pressure']['memory'], files['proc/pressure/memory'])
            self.assertEqual(result['zram']['zram0']['mm_stat'], files['sys/block/zram0/mm_stat'])
            self.assertEqual(result['zswap']['enabled'], 'Y\n')
            self.assertEqual(result['processes'][0]['cgroup']['error'], 'FileNotFoundError')
            self.assertEqual(result['pressure']['io']['error'], 'FileNotFoundError')
            self.assertEqual({name: (root / name).read_text() for name in files}, files)


if __name__ == '__main__':
    unittest.main()
