# Provenance

The studio, editable model, authored scenes, exporters and visual identity are original OpenHarness
contributor work under the package's MIT license. The original island implementation is retained
in `store/tools/experiences/` and is no longer this package's builder.

- Three.js 0.186.0 (MIT), pinned in the local toolchain; its license notice is retained in bundled
  HTML. Source: https://github.com/mrdoob/three
- esbuild 0.27.2 (MIT), build time only. https://github.com/evanw/esbuild
- Playwright Core 1.63.0 (Apache-2.0), browser verification. https://github.com/microsoft/playwright
- Khronos glTF Validator 2.0.0-dev.3.10 (Apache-2.0), independent export checks.
  https://github.com/KhronosGroup/glTF-Validator
- GLB encoding follows glTF 2.0: https://github.com/KhronosGroup/glTF/tree/main/specification/2.0
- VOX encoding and static transforms follow Ephtracy's published format specifications:
  https://github.com/ephtracy/voxel-model

No sampled textures, downloaded 3D models or generated bitmap assets are included. The harbor,
courtyard and dungeon are authored acceptance fixtures, not customer projects or evidence of an
installed coding agent completing those prompts. Setup reuses an installed Chrome/Chromium or
installs Playwright's browser into the package-local cache. The offline HTML embeds its runtime.
