# Fonts

Pets faces (always these files, whatever `PRO_FONT` is; baked by `scripts/gen_fonts.py`). All SIL OFL 1.1.

| File | Source | Version | sha256 |
|---|---|---|---|
| Inter-Bold.ttf, Inter-SemiBold.ttf, Inter-Regular.ttf | `extras/ttf/` of https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip (zip sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`) | Inter 4.1 | Bold `288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f`, SemiBold `78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3`, Regular `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82` |
| JetBrainsMono-Medium.ttf | `fonts/ttf/` of https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip (zip sha256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`) | JetBrains Mono 2.304 | `31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d` |

Base faces (`ht_pro_*`, from `LiberationSans-Regular.ttf` when the system font is not used; baked by `scripts/gen_fonts.py`, SIL OFL 1.1):

| File | Source | Version | sha256 |
|---|---|---|---|
| LiberationSans-Regular.ttf | `liberation-fonts-ttf-2.1.5/` of https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz (tarball sha256 `7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`) | Liberation Fonts 2.1.5 | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |

Licences: `LICENSE-Inter.txt`, `LICENSE-JetBrainsMono.txt`, `LICENSE-LiberationSans.txt` (the base faces' fallback; it covers `LiberationSans-Regular.ttf`, byte-identical to the 2.1.5 tarball's `LICENSE`).
