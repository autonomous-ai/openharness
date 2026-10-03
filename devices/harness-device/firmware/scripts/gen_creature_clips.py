#!/usr/bin/env python3
"""Compile curated text animation, not images, into immutable C frame data.

The source JSON preserves the inspected character frames, timing, provenance,
and adaptation notes. No downloader, converter or decoder runs on the ESP32.
"""
from pathlib import Path
import json

root = Path(__file__).resolve().parents[1]
source = root.parent / 'prototype/habitat/assets/creature-references/clips.json'
clips = json.loads(source.read_text())
fonts = {'ascii12': 'ht_ascii_art_12', 'ascii14': 'ht_ascii_art_14',
         'ascii16': 'ht_ascii_art_16', 'ascii20': 'ht_ascii_art_20',
         'ascii28': 'ht_ascii_art_28', 'ascii48': 'ht_ascii_art_48',
         'block16': 'ht_block_art_16', 'block_square': 'ht_block_art_square_10'}
out = ['// Generated from prototype/habitat/assets/creature-references/clips.json.',
       '// Source/artist/adaptation credits are preserved there and in CREATURE_GALLERY_02.md.']
total = 0
for i, clip in enumerate(clips):
    assert clip['rows'] <= 40 and len(clip['frames']) == len(clip['holds'])
    ends = []; elapsed = 0
    out.append(f'static const char *const clip_{i}_frames[] = {{')
    for frame, hold in zip(clip['frames'], clip['holds']):
        assert len(frame) == clip['rows'] and 0 < hold < 65536
        assert all(len(row) == clip['cols'] and len(row.encode()) < 128 for row in frame)
        allowed = lambda cp: cp == 32 or (0x2580 <= cp <= 0x259f if clip['font'].startswith('block') else 32 <= cp <= 126)
        assert all(allowed(ord(ch)) for row in frame for ch in row)
        text = '\n'.join(frame)
        out.append('    ' + json.dumps(text, ensure_ascii=False) + ',')
        total += len(text.encode()) + 1
        elapsed += hold; ends.append(elapsed)
    out.append('};')
    out.append(f'static const uint32_t clip_{i}_ends[] = {{'+','.join(map(str,ends))+'};')
out.append('static const ht_gallery_clip_t clips[] = {')
for i, clip in enumerate(clips):
    out.append('    {' + ','.join([json.dumps(clip['name']),str(clip['cols']),str(clip['rows']),
        str(len(clip['frames'])),str(sum(clip['holds'])), '&'+fonts[clip['font']],
        '0x'+clip['color'],f'clip_{i}_frames',f'clip_{i}_ends']) + '},')
out.append('};')
out.append('_Static_assert(sizeof(clips)/sizeof(clips[0]) == HT_CREATURES-HT_ORIGINAL_CREATURES, "gallery clip count");')
(root/'main/ui/habitat/creature_clips.inc').write_text('\n'.join(out)+'\n')
print(f'{len(clips)} text clips, {sum(len(c["frames"]) for c in clips)} poses, {total} UTF-8 frame bytes')
