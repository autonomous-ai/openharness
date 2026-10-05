import unittest
from footprint_guest import cpu, cpu_busy, memory, package_fields, package_row


class FootprintCounters(unittest.TestCase):
    def test_cpu_does_not_double_count_guest_time(self):
        self.assertEqual(cpu('cpu 10 20 30 40 5 6 7 8 9 10\ncpu0 1 2 3'), (126, 45))
        self.assertEqual(cpu_busy((100, 30), (200, 90)), 40)

    def test_invalid_cpu_intervals_are_not_performance_claims(self):
        for before, after in [((100, 30), (100, 30)), ((100, 30), (90, 20)), ((100, 30), (110, 50))]:
            with self.assertRaises(ValueError):
                cpu_busy(before, after)

    def test_available_not_free_defines_system_memory(self):
        result = memory('MemTotal: 1024 kB\nMemFree: 10 kB\nMemAvailable: 700 kB\nSwapTotal: 512 kB\nSwapFree: 500 kB\n')
        self.assertEqual(result['used_kib'], 324)
        self.assertEqual(result['swap_used_kib'], 12)

    def test_impossible_memory_sample_is_rejected(self):
        with self.assertRaises(ValueError):
            memory('MemTotal: 1024 kB\nMemAvailable: 1025 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')

    def test_package_metadata_retains_all_dependencies(self):
        result = package_fields('%NAME%\nexample\n\n%SIZE%\n12345\n\n%DEPENDS%\nlibc\nother>=2\n\n%REASON%\n1\n')
        self.assertEqual(result['DEPENDS'], ['libc', 'other>=2'])
        self.assertEqual(result['SIZE'], ['12345'])
        self.assertEqual(result['REASON'], ['1'])

    def test_optional_size_does_not_invent_zero_byte_savings(self):
        result = package_row('%NAME%\nbase\n\n%VERSION%\n3-1\n\n%DEPENDS%\nsystemd\n')
        self.assertIsNone(result['uncompressed_bytes'])
        self.assertEqual(result['size_status'], 'not recorded')
        self.assertTrue(result['explicit'])

    def test_recorded_zero_and_negative_size_are_distinct(self):
        text = '%NAME%\nexample\n\n%VERSION%\n1-1\n\n%SIZE%\n'
        self.assertEqual(package_row(text + '0\n')['uncompressed_bytes'], 0)
        with self.assertRaises(ValueError):
            package_row(text + '-1\n')


if __name__ == '__main__':
    unittest.main()
