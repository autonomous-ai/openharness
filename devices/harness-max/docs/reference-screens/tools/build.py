"""Copy the rendered screens to the output folder and write gallery.html (self-contained) and INDEX.md.

    python3 build.py <png-dir> <out-dir> <meta.json>

<png-dir> holds dial/, pro/, max/ (PNG) and anim/ (WebP). meta.json: {"main": "<sha>", "max": "<sha>", "date": "..."}.
"""
import base64
import io
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog as C  # noqa: E402

png_dir, out_dir, meta_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
meta = json.loads(meta_path.read_text())
here = Path(__file__).resolve().parent

FOLDER = {'dial': 'dial', 'pro': 'pro', 'max': 'max-draft'}


def webp(path, quality=86):
    im = Image.open(path)
    buf = io.BytesIO()
    if getattr(im, 'is_animated', False):
        buf.write(path.read_bytes())
    else:
        im.convert('RGB').save(buf, 'WEBP', quality=quality, method=5)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()


def collect():
    data = {'meta': meta, 'devices': []}
    for dev in ('dial', 'pro', 'max'):
        d = C.DEVICES[dev]
        names = sorted(p.stem for p in (png_dir / dev).glob('*.png'))
        if dev == 'dial':
            groups, assign, caps = C.DIAL_GROUPS, C.dial_group, C.DIAL_CAPTIONS
        elif dev == 'pro':
            groups, assign, caps = C.PRO_GROUPS, C.pro_group, C.PRO_CAPTIONS
        else:
            groups, assign, caps = [('max', 'Bản nháp Max', '')], (lambda n: 'max'), C.MAX_CAPTIONS
        by = {g[0]: [] for g in groups}
        for n in names:
            m = C.SEQ.match(n)
            item = {'n': n, 'c': caps.get(n, ''), 'src': webp(png_dir / dev / f'{n}.png'),
                    'file': f'{FOLDER[dev]}/{n}.png'}
            if m:
                item['seq'] = int(m.group(2)) > 0
                if not item['seq']:
                    item['c'] = '1 trong 32 khung hình của chuỗi này (bật "Hiện khung hình lặp" để xem hết).'
            by[assign(n)].append(item)
        anims = [{'n': p.stem.split('-', 1)[1], 'src': webp(p), 'file': f'anim/{p.name}'}
                 for p in sorted((png_dir / 'anim').glob(f'{dev}-*.webp'))]
        data['devices'].append({
            'id': dev, 'title': d['title'], 'short': d['short'], 'spec': d['spec'], 'shape': d['shape'], 'ux': d['ux'],
            'count': len(names), 'anims': anims,
            'groups': [{'id': g, 'title': t, 'desc': ds, 'items': by[g]} for g, t, ds in groups if by[g]],
        })
    data['gaps'] = C.GAPS
    return data


def write_index(data):
    m = data['meta']
    L = ['# Màn hình Dial, Pro và bản nháp Max', '',
         f'Export ngày {m["date"]} để chuẩn bị UI/UX cho Harness Max. Ảnh render bằng chính code C của firmware trên máy Mac '
         '(không phải ảnh chụp màn thật).', '',
         f'- Dial và Pro: repo `autonomous-harness`, nhánh `main` commit `{m["main"]}`.',
         f'- Max: nhánh `feat/harness-max-all` commit `{m["max"]}` (chưa merge, chưa lên board).',
         '- Xem nhanh: mở `gallery.html` (một file, ảnh nhúng sẵn, mở offline được).',
         '- Export lại: `bash export.sh` (xem đầu file để đổi repo, ref, thư mục ra).', '']
    for dev in data['devices']:
        L += [f'## {dev["title"]} ({dev["count"]} ảnh)', '', dev['spec'], '']
        L += [f'- {u}' for u in dev['ux']] + ['']
        if dev['anims']:
            L += ['Chuyển động: ' + ', '.join(f'`screens/{a["file"]}`' for a in dev['anims']), '']
        for g in dev['groups']:
            L += [f'### {g["title"]} ({len(g["items"])})', '']
            if g['desc']:
                L += [g['desc'], '']
            L += ['| Ảnh | Nội dung |', '|---|---|']
            for it in g['items']:
                L.append(f'| `screens/{it["file"]}` | {it["c"]} |')
            L.append('')
    L += ['## Dial, Pro làm được gì mà bản nháp Max chưa vẽ', '', '| Chủ đề | Dial | Pro | Max nháp |', '|---|---|---|---|']
    L += [f'| {a} | {b} | {c} | {d} |' for a, b, c, d in data['gaps']]
    L += ['', 'Biến thể không export: theme cam của Dial (`DEVICE_HABITAT_ORANGE`, chỉ đổi accent tím thành cam #FF6D00).', '']
    (out_dir / 'INDEX.md').write_text('\n'.join(L))


def main():
    out_dir.mkdir(parents=True, exist_ok=True)
    for dev, folder in FOLDER.items():
        dest = out_dir / 'screens' / folder
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(png_dir / dev, dest)
    dest = out_dir / 'screens' / 'anim'
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(png_dir / 'anim', dest)
    data = collect()
    for dev in data['devices']:   # gallery paths are relative to the out dir
        for g in dev['groups']:
            for it in g['items']:
                it['file'] = 'screens/' + it['file']
        for a in dev['anims']:
            a['file'] = 'screens/' + a['file']
    html = (here / 'gallery.template.html').read_text()
    blob = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    (out_dir / 'gallery.html').write_text(html.replace('/*DATA*/null', blob))
    for dev in data['devices']:
        for g in dev['groups']:
            for it in g['items']:
                it['file'] = it['file'][len('screens/'):]
        for a in dev['anims']:
            a['file'] = a['file'][len('screens/'):]
    write_index(data)
    size = (out_dir / 'gallery.html').stat().st_size
    print(f'gallery.html {size / 1e6:.1f} MB;', ', '.join(f'{d["id"]} {d["count"]}' for d in data['devices']))


main()
