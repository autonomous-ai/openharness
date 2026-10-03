#!/usr/bin/env python3
"""Write tui/THIRD_PARTY_NOTICES.md: the licences hn's binary carries (`hn --licenses`).

hn translates parts of tmux (ISC) and fzf (MIT) into Rust, and statically links the crates in
Cargo.lock. Their licences ask for their notices to travel with every copy, so this file is
generated from each crate's own licence text (from `cargo metadata`, read out of the local cargo
registry) and embedded in the binary. Run it after changing dependencies:

    cd tui && python3 scripts/notices.py

`cargo test` fails when a crate in Cargo.lock is missing from the file.
"""
import json, os, re, subprocess, sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
TUI = os.path.dirname(HERE)

TMUX_COPYRIGHTS = """\
Copyright (c) 2007, 2008, 2009, 2010, 2011, 2015, 2019 Nicholas Marriott <nicholas.marriott@gmail.com>
Copyright (c) 2009 Nicholas Marriott <nicm@openbsd.org>
Copyright (c) 2008, 2009 Tiago Cunha <me@tiagocunha.org>
Copyright (c) 2014 Tiago Cunha <tcunha@users.sourceforge.net>
Copyright (c) 2011 George Nachman <tmux@georgester.com>
Copyright (c) 2016 Stephen Kent <smkent@smkent.net>
Copyright (c) 2020 Anindya Mukherjee <anindya49@hotmail.com>"""

ISC = """\
Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF MIND, USE, DATA OR PROFITS, WHETHER
IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE."""

FZF = """\
The MIT License (MIT)

Copyright (c) 2013-2025 Junegunn Choi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE."""


def licence_files(src):
    """A crate's licence files, the MIT one first when there is a choice."""
    names = [n for n in os.listdir(src) if re.match(r'(?i)^(licen[cs]e|copying|unlicense|notice)', n)]
    def rank(n):
        u = n.upper()
        if 'MIT' in u: return 0
        if u.startswith('NOTICE'): return 3
        if 'APACHE' in u: return 2
        return 1
    return sorted(names, key=lambda n: (rank(n), n))


def main():
    meta = json.loads(subprocess.check_output(['cargo', 'metadata', '--format-version', '1', '--locked'], cwd=TUI))
    lock = open(os.path.join(TUI, 'Cargo.lock')).read()
    locked = set(re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', lock))
    crates = sorted((p for p in meta['packages'] if (p['name'], p['version']) in locked and p['name'] != 'harness-tui'),
                    key=lambda p: (p['name'], p['version']))
    groups = OrderedDict()  # licence text -> [crate ids]
    rows = []
    for p in crates:
        src = os.path.dirname(p['manifest_path'])
        spdx = p.get('license') or ''
        files = licence_files(src)
        # One text per crate: its MIT file when it offers MIT, else each file it has (a NOTICE too).
        texts = []
        mit = [f for f in files if 'MIT' in f.upper()]
        chosen = mit[:1] if mit else [f for f in files if not f.upper().startswith('NOTICE')][:1]
        chosen += [f for f in files if f.upper().startswith('NOTICE')]
        for f in chosen:
            t = open(os.path.join(src, f), encoding='utf-8', errors='replace').read().strip()
            if t: texts.append(t)
        if not texts and 'MIT' in spdx:
            # No licence file in the published crate: MIT's text, with its authors as the manifest names them.
            holders = ', '.join(a.split(' <')[0] for a in p.get('authors') or []) or f"the {p['name']} authors"
            texts = [FZF.replace('The MIT License (MIT)\n\nCopyright (c) 2013-2025 Junegunn Choi', f'MIT License\n\nCopyright (c) {holders}')]
        if not texts:
            texts = [f'(No licence file in the published crate. Its licence, from its manifest: {spdx}.)']
        rows.append((p['name'], p['version'], spdx))
        for t in texts:
            groups.setdefault(t, []).append(f"{p['name']} {p['version']}")
    out = []
    out.append('# Third-party notices\n')
    out.append('hn (`harness tui`) is MIT-licensed, Copyright (c) 2026 Autonomous, Inc. It contains code translated')
    out.append('from tmux and fzf, and it statically links the Rust crates listed below. Their notices follow.')
    out.append('This file is embedded in the binary: `hn --licenses` prints it.\n')
    out.append('## tmux\n')
    out.append('hn\'s layouts, pane borders, status line and format drawing, key tables, command parser and')
    out.append('commands, formats, options, copy mode, menus, alerts and mouse handling are translated from')
    out.append('tmux 3.5a (https://github.com/tmux/tmux): `src/layout.rs`, `src/borders.rs`, `src/draw.rs`,')
    out.append('`src/cmd.rs`, `src/cmdparse.rs`, `src/commands.rs`, `src/paste.rs`, `src/mouse.rs`, `src/keys.rs`,')
    out.append('`src/format.rs`, `src/options/`, `src/tmuxconf.rs`, and parts of `src/app.rs`, `src/input.rs`,')
    out.append('`src/pane.rs` and `src/ui.rs`. The tmux sources carry these notices:\n')
    out.append('```')
    out.append(TMUX_COPYRIGHTS + '\n\n' + ISC)
    out.append('```\n')
    out.append('## fzf\n')
    out.append('hn\'s fuzzy matcher (`src/fzf.rs`) and its list drawing (`src/picker.rs`, `src/theme.rs`, parts of')
    out.append('`src/ui.rs`) are translated from fzf 0.67 (https://github.com/junegunn/fzf).\n')
    out.append('```')
    out.append(FZF)
    out.append('```\n')
    out.append(f'## Rust crates ({len(rows)})\n')
    out.append('| Crate | Version | Licence |')
    out.append('|---|---|---|')
    for name, version, spdx in rows:
        out.append(f'| {name} | {version} | {spdx} |')
    out.append('')
    out.append('### Licence texts\n')
    out.append('Each text below is followed by the crates it comes from. Where a crate offers a choice, its MIT')
    out.append('text is given.\n')
    for text, ids in groups.items():
        out.append('**' + ', '.join(ids) + '**\n')
        out.append('```')
        out.append(text.replace('```', "'''"))
        out.append('```\n')
    path = os.path.join(TUI, 'THIRD_PARTY_NOTICES.md')
    open(path, 'w').write('\n'.join(out))
    print(f'wrote {path}: {len(rows)} crates, {len(groups)} licence texts, {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
