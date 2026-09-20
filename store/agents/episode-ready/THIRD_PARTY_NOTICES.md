# Third-party notices

Episode Ready is an original workflow. Nothing below is vendored into this repository; every item
is fetched by `toolchain/setup.sh` at the version pinned in [`VERSIONS`](VERSIONS), verified, and
installed inside the package.

## FFmpeg 9.0.2 — LGPL-2.1-or-later

<https://ffmpeg.org> · fetched from conda-forge as `ffmpeg=9.0.2=lgpl*`, the build configured
`--disable-gpl --enable-version3`. Used for decoding, repair filtering, ITU-R BS.1770 loudness
measurement (`ebur128`, `loudnorm`), mixing, encoding and muxing.

Includes, in that build: **LAME** (LGPL-2.0, MP3 encoding), **libopus** (BSD-3-Clause),
**libvorbis** (BSD-3-Clause), **FLAC** (BSD-3-Clause), **librsvg** (LGPL-2.1-or-later),
**libwebp** (BSD-3-Clause) and others listed by `ffmpeg -version` in the installed environment.
FFmpeg's own licence text ships with the conda-forge package under
`toolchain/.conda/share/doc/ffmpeg/`.

## faster-whisper 1.2.1 — MIT

<https://github.com/SYSTRAN/faster-whisper> · SYSTRAN. Copyright (c) 2023 SYSTRAN.

## CTranslate2 4.8.2 — MIT

<https://github.com/OpenNMT/CTranslate2> · OpenNMT. Copyright (c) 2018-present OpenNMT.

## Whisper model weights — MIT

Converted to the CTranslate2 format by SYSTRAN from OpenAI's Whisper
(<https://github.com/openai/whisper>, MIT). Pinned by Hugging Face commit in `VERSIONS`:

| model | repository | commit |
|---|---|---|
| `base.en` (installed by default) | `Systran/faster-whisper-base.en` | `3d3d5dee26484f91867d81cb899cfcf72b96be6c` |
| `small.en` | `Systran/faster-whisper-small.en` | `d1d751a5f8271d482d14ca55d9e2deeebbae577f` |
| `medium.en` | `Systran/faster-whisper-medium.en` | `a29b04bd15381511a9af671baec01072039215e3` |
| `distil-small.en` | `Systran/faster-distil-whisper-small.en` | `ef77d90526ccd62cde3808ee70626a01e5cf83e4` |
| `base`, `small`, `large-v3` | `Systran/faster-whisper-*` | see `VERSIONS` |
| `large-v3-turbo` | `deepdml/faster-whisper-large-v3-turbo-ct2` | `4df90f75321148c3a29a9e2351b7ddf8f5b115a8` |

Also pulled in by faster-whisper and installed in `toolchain/.venv`: **onnxruntime** (MIT, the
Silero VAD), **tokenizers** (Apache-2.0), **huggingface-hub** (Apache-2.0), **av** (BSD-3-Clause),
**numpy** (BSD-3-Clause), **tqdm** (MPL-2.0 / MIT).

## Python — PSF licence

CPython 3.12, downloaded by `uv` through the shared `toolchain/runtimes.sh`, which is
Autonomous's and identical in every Harness Store package.

## The worked example recording — public domain

*To Write or Not To Write* by **Susan Andrews Rice**, from *The Writer*, vol. 6, April 1892; read
for **LibriVox** in [Short Nonfiction Collection Vol.
013](https://archive.org/details/nonfiction013_librivox). LibriVox recordings are in the public
domain (the item declares `creativecommons.org/licenses/publicdomain/`). Fetched at install,
pinned by SHA-256 `866ee34315b826cc1bc6167ec208a1ebb744cce66bebeddcac185a00998a94d6`, trimmed to
its first 105 seconds and produced through this harness's own pipeline.

## Everything else

The manifest, `AGENTS.md`, the skills, the `ep` toolchain, the viewer, the mark and the
documentation are Autonomous's, MIT licensed. No upstream project's logo or trademark is used.
