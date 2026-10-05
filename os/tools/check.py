#!/usr/bin/env python3
"""Portable checks for image inputs, without installing packages or touching disks."""
import ast
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
for p in root.rglob('*'):
    if not p.is_file() or set(p.relative_to(root).parts) & {'work', 'dist', 'test-results', '__pycache__'}:
        continue
    if p.suffix == '.py' or p.name == 'hn-os':
        ast.parse(p.read_text(), filename=str(p))
    elif p.suffix == '.json':
        json.loads(p.read_text())
    elif p.suffix == '.xml':
        ET.parse(p)
    elif p.parent.name == 'mkinitcpio.conf.d' or p.read_bytes().startswith((b'#!/bin/sh', b'#!/bin/bash', b'#!/usr/bin/env bash')):
        subprocess.run(['bash', '-n', str(p)], check=True)
print('Python, JSON, XML and shell syntax checked.')
