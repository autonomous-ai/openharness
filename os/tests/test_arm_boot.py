"""Reject incompatible or truncated kernels before starting a test VM."""
import struct
import unittest

from arm_boot import check_arm_image, zboot_payload


class KernelImages(unittest.TestCase):
    def zboot(self):
        data = bytearray(80)
        data[:8] = b'MZ\0\0zimg'
        struct.pack_into('<II', data, 8, 64, 8)
        data[24:28] = b'zstd'
        data[56:60] = b'\xcd\x23\x82\x81'
        data[64:72] = b'payload!'
        data[72:80] = b'trailer!'
        return data

    def test_extracts_only_declared_payload(self):
        self.assertEqual(zboot_payload(self.zboot()), b'payload!')

    def test_rejects_wrong_header_compression_and_truncated_payload(self):
        for position, replacement in [(0, b'ZZ'), (24, b'gzip'), (56, b'nope')]:
            data = self.zboot()
            data[position:position + len(replacement)] = replacement
            with self.subTest(position=position), self.assertRaises(ValueError):
                zboot_payload(data)
        for data in [self.zboot()[:32], self.zboot()[:70]]:
            with self.assertRaises(ValueError):
                zboot_payload(data)

    def test_rejects_payload_outside_image(self):
        for offset, size in [(0, 8), (64, 0), (80, 1), (0xffffffff, 0xffffffff)]:
            data = self.zboot()
            struct.pack_into('<II', data, 8, offset, size)
            with self.subTest(offset=offset, size=size), self.assertRaises(ValueError):
                zboot_payload(data)

    def test_accepts_only_little_endian_16k_arm_image(self):
        data = bytearray(64)
        data[56:60] = b'ARM\x64'
        struct.pack_into('<Q', data, 24, 0xc)
        check_arm_image(data)
        for flags in [0, 2, 6, 0xd]:
            struct.pack_into('<Q', data, 24, flags)
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                check_arm_image(data)
        with self.assertRaises(ValueError):
            check_arm_image(data[:60])
        with self.assertRaises(ValueError):
            check_arm_image(bytes(64))


if __name__ == '__main__':
    unittest.main()
