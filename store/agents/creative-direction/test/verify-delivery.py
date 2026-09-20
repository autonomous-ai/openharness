#!/usr/bin/env python3
"""Read actual deliveries independently of the JavaScript renderer (Python stdlib + Poppler)."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET
import zlib

if not shutil.which('pdfinfo'):
    raise SystemExit('Install Poppler (pdfinfo and pdftotext) for independent PDF verification.')


def png_info(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'Invalid PNG signature'
    width, height, depth, color = struct.unpack('>IIBB', data[16:26])
    cursor, compressed = 8, bytearray()
    while cursor < len(data):
        size = struct.unpack('>I', data[cursor:cursor + 4])[0]
        kind = data[cursor + 4:cursor + 8]
        body = data[cursor + 8:cursor + 8 + size]
        crc = struct.unpack('>I', data[cursor + 8 + size:cursor + 12 + size])[0]
        assert zlib.crc32(kind + body) & 0xffffffff == crc, 'Broken PNG chunk'
        if kind == b'IDAT':
            compressed.extend(body)
        cursor += size + 12
    raw = zlib.decompress(compressed)
    assert raw, 'Empty image'
    return width, height, depth, color, raw


def rgba_rows(info):
    width, height, depth, color, raw = info
    assert depth == 8 and color == 6, 'Expected RGBA logo export'
    stride, previous = width * 4, bytearray(width * 4)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        row = bytearray(raw[start + 1:start + stride + 1])
        for x in range(stride):
            a = row[x - 4] if x >= 4 else 0
            b = previous[x]
            c = previous[x - 4] if x >= 4 else 0
            if kind == 1:
                predictor = a
            elif kind == 2:
                predictor = b
            elif kind == 3:
                predictor = (a + b) // 2
            elif kind == 4:
                p = a + b - c
                distances = (abs(p - a), abs(p - b), abs(p - c))
                predictor = (a, b, c)[distances.index(min(distances))]
            else:
                assert kind == 0
                predictor = 0
            row[x] = (row[x] + predictor) & 255
        yield row
        previous = row


def alpha_range(info):
    low, high = 255, 0
    for row in rgba_rows(info):
        alpha = row[3::4]
        low, high = min(low, min(alpha)), max(high, max(alpha))
    return low, high


def compare_logos(before, after):
    results = []
    for path in sorted(Path(before).glob('*.png')):
        a, b = path.read_bytes(), (Path(after) / path.name).read_bytes()
        if a == b:
            results.append({'logo': path.name, 'identical': True})
            continue
        ia, ib = png_info(a), png_info(b)
        assert ia[:4] == ib[:4], path.name + ': logo dimensions changed'
        maximum, total, changed = 0, 0, 0
        for ra, rb in zip(rgba_rows(ia), rgba_rows(ib)):
            for x in range(0, len(ra), 4):
                aa, ab = ra[x + 3], rb[x + 3]
                differences = [abs(ra[x + c] * aa - rb[x + c] * ab) / 255 for c in range(3)]
                differences.append(abs(aa - ab))
                maximum = max(maximum, *differences)
                total += sum(differences)
                changed += any(differences)
        pixels = ia[0] * ia[1]
        mean, fraction = total / (pixels * 4), changed / pixels
        # SVG must match byte for byte. Rasterizers may round a few transparent
        # edge pixels differently across processes; compare visible RGBA values.
        assert maximum <= 3 and mean < .001 and fraction < .001, path.name + ': visible logo changed'
        results.append({'logo': path.name, 'identical': False,
                        'maxPremultipliedError': maximum, 'meanError': mean, 'changedFraction': fraction})
    assert results, 'No logo rasters compared'
    return results


def verify(folder):
    root = Path(folder)
    report = json.loads((root / 'verification.json').read_text())
    project = json.loads((root / 'project.forme.json').read_text())
    for board in report['boards']:
        path = root / board['id']
        vector = path.with_suffix('.svg').read_bytes()
        tree = ET.fromstring(vector)
        assert tree.tag.endswith('svg')
        assert hashlib.sha256(vector).hexdigest() == board['sha256']
        assert png_info(path.with_suffix('.png').read_bytes())[:2] == tuple(board['pixels'])
        info = subprocess.check_output(['pdfinfo', str(path.with_suffix('.pdf'))], text=True)
        assert re.search(r'Pages:\s+1\b', info), str(path) + ': expected one PDF page'
        dimensions = re.search(r'Page size:\s+([\d.]+) x ([\d.]+)', info)
        assert all(abs(float(value) - mm / 25.4 * 72) < 1.1
                   for value, mm in zip(dimensions.groups(), board['printMm'])), str(path) + ': wrong PDF dimensions'
        words = subprocess.check_output(['pdftotext', str(path.with_suffix('.pdf')), '-'], text=True)
        assert words.strip(), str(path) + ': no extractable text'
    for font in project['fonts']:
        stem = font['family'].replace(' ', '-')
        assert (root / 'fonts' / (stem + '.ttf')).stat().st_size > 1000
        assert 'SIL OPEN FONT LICENSE' in (root / 'fonts' / (stem + '-LICENSE.txt')).read_text()
    logos = sorted((root / 'logos').glob('*.png'))
    assert logos, 'No usable logo PNGs'
    assert alpha_range(png_info(logos[0].read_bytes())) == (0, 255), 'Logo needs real transparency and visible artwork'
    for path in (root / 'logos').glob('*.svg'):
        ET.fromstring(path.read_bytes())
    assert (root / 'website/index.html').is_file()
    assert (root / 'brand-guide.pdf').is_file()
    return {'directory': str(root), 'artboards': len(report['boards']), 'logos': len(logos),
            'pdfPagesAndDimensions': True, 'svgPngAndTransparency': True}


if __name__ == '__main__':
    if sys.argv[1] == '--compare-logos':
        print(json.dumps(compare_logos(sys.argv[2], sys.argv[3])))
    else:
        target = Path(sys.argv[1])
        if target.is_dir() and (target / 'acceptance.json').exists():
            target /= 'acceptance.json'
        if target.is_file():
            acceptance = json.loads(target.read_text())
            results = [verify(report[phase]) for report in acceptance['reports'] for phase in ('before', 'after')]
        else:
            results = [verify(target)]
        print(json.dumps({'independentReader': 'Python stdlib and Poppler', 'results': results}, indent=2))
