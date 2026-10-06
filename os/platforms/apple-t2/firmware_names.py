"""Translate local Apple wireless firmware names into Linux driver requests.

Adapted from the naming/pruning rules in t2linux's firmware.sh, revision
11fc0a8d8cfb61affd0cb9d1ac245c1b6c16d3cd (2026-10-06 review).
https://github.com/t2linux/wiki/blob/11fc0a8d8cfb61affd0cb9d1ac245c1b6c16d3cd/docs/tools/firmware.sh
The original Python implementation is based on work by the Asahi Linux Contributors.

Copyright (C) 2024 Aditya Garg <gargaditya08@live.com>
Copyright (C) 2024 Orlando Chamberlain <redecorating@protonmail.com>
Copyright (C) 2024 Sharpened Blade <sharpenedblade@proton.me>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
import re


WIFI_FOLDERS = {'C-4355__s-C1', 'C-4364__s-B2', 'C-4364__s-B3', 'C-4377__s-B3'}
EXTENSIONS = {'trx': 'bin', 'txt': 'txt', 'clmb': 'clm_blob', 'txcb': 'txcap_blob'}
DIMENSIONS = ('C', 's', 'P', 'M', 'V', 'm', 'A')


def nvram(data):
    lines = []
    for line in data.decode('ascii').split('\n'):
        if not line:
            continue
        key, separator, value = line.partition('=')
        if not separator or not key.strip():
            raise ValueError('Invalid Apple Wi-Fi NVRAM.')
        lines.append(key.strip() + '=' + value + '\n')
    return ''.join(lines).encode('ascii')


class Node:
    def __init__(self):
        self.data = None
        self.children = {}

    def __eq__(self, other):
        return isinstance(other, Node) and self.data == other.data and self.children == other.children

    def prune(self, depth=0):
        for child in self.children.values():
            child.prune(depth + 1)
        if self.data is None and self.children and depth > 3:
            first = next(iter(self.children.values()))
            if all(child == first for child in self.children.values()):
                self.data = first.data
        if self.data is not None and all(child.data == self.data for child in self.children.values()):
            self.children = {}

    def files(self, ident=()):
        if self.data is not None:
            yield ident, self.data
        for key, child in sorted(self.children.items()):
            yield from child.files(ident + (key,))


def put(output, name, data):
    if name in output and output[name] != data:
        raise ValueError('Conflicting Apple firmware variants: ' + name)
    output[name] = data


def convert(files):
    """Pure conversion of already bounded, regular input files; no filesystem I/O."""
    tree, result = Node(), {}
    for path, data in sorted(files.items()):
        parts = path.split('/')
        if len(parts) == 3 and parts[0] == 'wifi' and parts[1] in WIFI_FOLDERS:
            stem, separator, ext = parts[2].rpartition('.')
            if not separator or ext not in EXTENSIONS:
                continue
            if ext != 'txt':
                stem = 'P-' + stem
            properties = {}
            for component in (parts[1] + '_' + stem).split('_'):
                if not component:
                    continue
                key, separator, value = component.partition('-')
                if not separator or not value or key not in DIMENSIONS or key in properties:
                    raise ValueError('Invalid Apple firmware dimensions: ' + path)
                if key == 'P' and '-' in value:
                    value, antenna = value.split('-', 1)
                    properties['A'] = antenna
                properties[key] = value
            ident = (ext,) + tuple(properties[key] for key in DIMENSIONS if key in properties)
            if ext == 'txt':
                data = nvram(data)
            node = tree
            for key in ident:
                node = node.children.setdefault(key, Node())
            if node.data is not None and node.data != data:
                raise ValueError('Conflicting Apple firmware dimensions: ' + path)
            node.data = data
        elif len(parts) == 2 and parts[0] == 'bluetooth':
            stem, _, ext = parts[1].rpartition('.')
            if ext not in {'bin', 'ptb'} or '_DEV' in stem:
                continue
            words = stem.split('_')
            chip = re.fullmatch(r'bcm(43[0-9]{2})([a-z][0-9])', words[0].lower())
            if not chip or chip[1] != '4377' or 'PCIE' not in words:
                continue  # UART and Apple Silicon radios are not this platform.
            index = words.index('PCIE') + 1
            if index < len(words) and words[index] == 'macOS':
                index += 1
            vendors = {value for key, value in {'MUR': 'm', 'USI': 'u', 'GEN': None}.items() if key in words}
            if index >= len(words) or len(vendors) != 1:
                raise ValueError('Ambiguous Apple Bluetooth firmware: ' + path)
            board = words[index].removesuffix('ES2').lower()
            if not re.fullmatch(r'[a-z0-9]+', board):
                raise ValueError('Invalid Apple Bluetooth board.')
            vendor = vendors.pop()
            name = 'brcmbt' + ''.join(chip.groups()) + '-apple,' + board
            put(result, name + ('-' + vendor if vendor else '') + '.' + ext, data)
    tree.prune()
    for ident, data in tree.files():
        ext, chip, revision, *rest = ident
        name = 'brcmfmac' + chip + revision.lower() + '-pcie.apple'
        put(result, name + (',' + '-'.join(rest) if rest else '') + '.' + EXTENSIONS[ext], data)
    return result
