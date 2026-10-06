"""Check lossless atlas packing against a saved pre-change pro_fonts.c.

The baseline is explicit: save the current generated atlas before changing its
generator. No glyph pixels or expected metrics are derived from the packer.
Two fresh generator runs must also match the candidate byte for byte.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SIZES = (24, 32, 42, 56)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fonts(path):
    source = path.read_text()
    assert set(map(int, re.findall(r"const ht_pro_font_t ht_pro_(\d+)=", source))) == set(SIZES)
    result = {}
    for size in SIZES:
        alpha = re.search(rf"alpha_{size}\[\]=\{{(.*?)\}};", source, re.S)
        table = re.search(rf"glyphs_{size}\[\]=\{{(.*?)\}};", source, re.S)
        header = re.search(rf"ht_pro_{size}=\{{(\d+),(\d+),(\d+),(\d+),glyphs_{size},alpha_{size}\}};", source)
        assert alpha and table and header, f"Missing font {size}"
        data = bytes(int(x) for x in re.findall(r"\d+", alpha.group(1)))
        glyphs = [tuple(map(int, values)) for values in re.findall(r"\{(\d+),(\d+),(\d+)\}", table.group(1))]
        first, last, height, count = map(int, header.groups())
        assert (first, last, count) == (32, 255, 326), f"Coverage changed in {size}"
        assert len(glyphs) == count
        masks = []
        for index, (offset, width, advance) in enumerate(glyphs):
            length = (height * width + 1) // 2
            assert width > 0 and advance > 0 and offset + length <= len(data), (size, index)
            masks.append((width, advance, data[offset:offset + length]))
        result[size] = {"header": (first, last, height, count), "data": data, "masks": masks}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, default=ROOT / "generated/pro_fonts.c")
    args = parser.parse_args()
    before, after = fonts(args.baseline), fonts(args.candidate)
    report = []
    for size in SIZES:
        old, new = before[size], after[size]
        assert old["header"] == new["header"], f"Font metrics changed in {size}"
        assert old["masks"] == new["masks"], f"Glyph metrics or mask bytes changed in {size}"
        assert len(new["data"]) <= len(old["data"]), f"Packing grew in {size}"
        report.append({"fontPx": size, "glyphs": len(new["masks"]),
                       "beforeBytes": len(old["data"]), "afterBytes": len(new["data"]),
                       "savedBytes": len(old["data"]) - len(new["data"]),
                       "alphaSha256": digest(new["data"])})
    runs = []
    with tempfile.TemporaryDirectory(prefix="harness-font-packing-") as directory:
        temp = Path(directory)
        for index in range(2):
            tools = temp / str(index) / "tools"
            tools.mkdir(parents=True)
            generator = tools / "generate_fonts.py"
            shutil.copy2(ROOT / "tools/generate_fonts.py", generator)
            subprocess.run([sys.executable, str(generator)], check=True, capture_output=True, timeout=60)
            generated = (tools.parent / "generated/pro_fonts.c").read_bytes()
            assert generated == args.candidate.read_bytes(), f"Generator output differs in run {index + 1}"
            runs.append(digest(generated))
    print(json.dumps({"glyphMasksAndMetricsIdentical": sum(row["glyphs"] for row in report),
                      "baselineSha256": digest(args.baseline.read_bytes()),
                      "candidateSha256": digest(args.candidate.read_bytes()),
                      "deterministicRunSha256": runs,
                      "savedBytes": sum(row["savedBytes"] for row in report), "fonts": report}, indent=2))


if __name__ == "__main__":
    main()
