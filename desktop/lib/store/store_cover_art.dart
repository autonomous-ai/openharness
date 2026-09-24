import 'package:flutter/material.dart';

/// Covers help people browse a tool's possibilities. They are deliberately
/// separate from the screenshots paired with prompts in store_project_examples.
/// Keep originals, attribution and license notices in assets/store/README.md.
class StoreCoverArt {
  const StoreCoverArt({
    required this.asset,
    required this.description,
    this.credit,
    this.source,
    this.license,
    this.alignment = Alignment.center,
    this.fit = BoxFit.cover,
    this.background,
    this.scale = 1,
    this.imageSize,
    this.viewport,
  }) : assert(viewport == null || imageSize != null);

  final String asset;
  final String description;
  final String? credit;
  final String? source;
  final String? license;
  final Alignment alignment;
  final BoxFit fit;
  final Color? background;
  final double scale;

  /// Pixel coordinates in the unmodified source. Frame the useful output instead
  /// of shrinking an entire application window and its controls into a card.
  final Size? imageSize;
  final Rect? viewport;
}

const storeCoverArt = <String, StoreCoverArt>{
  'autonomous/blender': StoreCoverArt(
    asset: 'assets/store/covers/blender.jpg',
    description: 'DOGWALK: a snowy world made in Blender',
    credit: 'Blender Foundation · DOGWALK',
    source: 'https://www.blender.org/download/demo-files/',
    license: 'CC BY 4.0',
    background: Color(0xffbbcedc),
  ),
  'autonomous/kicad': StoreCoverArt(
    asset: 'assets/store/covers/kicad.jpg',
    description: 'A circuit board in KiCad’s 3D viewer',
    credit: 'KiCad contributors',
    source: 'https://www.kicad.org/discover/3dviewer/',
    license: 'CC BY 3.0',
    scale: 1.13,
    alignment: Alignment(0, .25),
  ),
  'autonomous/freecad': StoreCoverArt(
    asset: 'assets/store/covers/freecad.png',
    description: 'From a constrained sketch to gears and a toolpath in FreeCAD',
    credit: 'FreeCAD contributors',
    source: 'https://github.com/FreeCAD/FreeCAD-Homepage',
    license: 'LGPL 2.1',
    fit: BoxFit.contain,
    background: Color(0xff243c52),
  ),
  'autonomous/mujoco': StoreCoverArt(
    asset: 'assets/store/covers/mujoco.jpg',
    description: 'A Unitree G1 robot rendered in MuJoCo Menagerie',
    credit: 'MuJoCo Menagerie · Unitree Robotics',
    source: 'https://github.com/google-deepmind/mujoco_menagerie/tree/main/unitree_g1',
    license: 'BSD 3-Clause',
    fit: BoxFit.contain,
    background: Color(0xff253f57),
  ),
  'autonomous/marimo': StoreCoverArt(
    asset: 'assets/store/covers/marimo.jpg',
    description: 'An interactive Altair scatter plot in marimo',
    credit: 'marimo contributors',
    source: 'https://github.com/marimo-team/marimo/blob/main/docs/_static/example-thumbs/altair.png',
    license: 'Apache 2.0',
    fit: BoxFit.contain,
    background: Colors.white,
  ),
  'autonomous/autonomous-workshop': StoreCoverArt(
    asset: 'assets/store/covers/workshop.jpg',
    description: 'A honeycomb desk organizer made with Autonomous Workshop',
  ),
  'autonomous/creative-direction': StoreCoverArt(
    asset: 'assets/store/covers/creative-direction.jpg',
    description: 'Stillwater identity and packaging in Creative Direction',
  ),
  'autonomous/generative-art': StoreCoverArt(
    asset: 'assets/store/covers/generative-art.jpg',
    description: 'Canopy: a generative artwork made with Harness',
  ),
  'autonomous/voxel-worlds': StoreCoverArt(
    asset: 'assets/store/covers/voxel-worlds.jpg',
    description: 'Amber Vault: a world made with Voxel Worlds',
  ),
  'autonomous/music-studio': StoreCoverArt(
    asset: 'assets/store/covers/music-studio.jpg',
    description: 'Keepsake: a composition in Music Studio',
    imageSize: Size(1600, 1478),
    viewport: Rect.fromLTWH(24, 133, 1552, 1108),
  ),
  'autonomous/data-studio': StoreCoverArt(
    asset: 'assets/store/covers/data-studio.jpg',
    description: 'Data Studio’s evidence view',
  ),
  'autonomous/drone-pilot': StoreCoverArt(
    asset: 'assets/store/covers/drone-pilot.jpg',
    description: 'Works Yard: a simulated mission in Drone Pilot',
  ),
  'autonomous/game-master': StoreCoverArt(
    asset: 'assets/store/covers/game-master.jpg',
    description: 'Signal Garden: a game made with Harness',
  ),
  'autonomous/lab-bench': StoreCoverArt(
    asset: 'assets/store/covers/lab-bench.jpg',
    description: 'Canopy: an experiment in Lab Bench',
  ),
  'autonomous/jev-browser': StoreCoverArt(
    asset: 'assets/store/covers/jev-browser.jpg',
    description:
        'Jev Browser exploring pages and collecting structured results',
    alignment: Alignment.topCenter,
    imageSize: Size(1600, 1000),
    viewport: Rect.fromLTWH(16, 80, 1560, 650),
  ),
  'autonomous/jev-sheets': StoreCoverArt(
    asset: 'assets/store/covers/jev-sheets.jpg',
    description: 'A typed column in Jev Sheets',
    alignment: Alignment.topCenter,
    imageSize: Size(1600, 1000),
    viewport: Rect.fromLTWH(112, 120, 1408, 610),
  ),
  'autonomous/roundtable': StoreCoverArt(
    asset: 'assets/store/covers/roundtable.jpg',
    description: 'Roundtable’s map of agreement and disagreement',
    alignment: Alignment.topCenter,
    imageSize: Size(1500, 1150),
    viewport: Rect.fromLTWH(38, 172, 1425, 437),
  ),
  'autonomous/phaser': StoreCoverArt(
    asset: 'assets/store/covers/phaser.jpg',
    description:
        'Sunset Fox: a playable platformer made with the Phaser harness',
  ),
  'autonomous/manim': StoreCoverArt(
    asset: 'assets/store/covers/manim.jpg',
    description: 'A chess knight drawn with Fourier epicycles in Manim',
  ),
  'autonomous/openmontage': StoreCoverArt(
    asset: 'assets/store/covers/openmontage.jpg',
    description: 'Lanterns: a title sequence made with OpenMontage',
  ),
  'autonomous/remotion': StoreCoverArt(
    asset: 'assets/store/covers/remotion.jpg',
    description: 'Year in Running: a video made with the Remotion harness',
  ),
  'autonomous/strudel': StoreCoverArt(
    asset: 'assets/store/covers/strudel.jpg',
    description: 'Synthwave Night Drive in Strudel',
  ),
  'autonomous/typst': StoreCoverArt(
    asset: 'assets/store/covers/typst.jpg',
    description: 'An orbital mechanics guide typeset with Typst',
    alignment: Alignment.topCenter,
  ),
  'autonomous/excalidraw': StoreCoverArt(
    asset: 'assets/store/covers/excalidraw.jpg',
    description: 'A system architecture diagram in Excalidraw',
  ),
  'autonomous/rdkit': StoreCoverArt(
    asset: 'assets/store/covers/rdkit.jpg',
    description: 'Molecular structures explored with RDKit',
  ),

  'autonomous/ableton-ai': StoreCoverArt(
    asset: 'assets/store/covers/ableton-ai.jpg',
    description: 'Arrangement, instruments, and modulation in Ableton Live',
    credit: '© Ableton AG',
    source: 'https://www.ableton.com/en/press/',
    license: 'Ableton press image',
    // Scaled with the art when it was re-encoded at 1600px wide (2880 → 1600):
    // the viewport is in PIXELS of this file, so the two move together or the
    // frame lands somewhere else in the picture.
    imageSize: Size(1600, 984),
    viewport: Rect.fromLTWH(517, 93, 1056, 640),
  ),
  'autonomous/bonsai-mcp': StoreCoverArt(
    asset: 'assets/store/covers/bonsai-mcp.jpg',
    description: 'An IFC building in Bonsai’s official example project',
    credit: 'IfcOpenShell contributors',
    source: 'https://docs.bonsaibim.org/quickstart/explore_model.html',
    license: 'GPL 3.0 or later',
    imageSize: Size(1110, 677),
    viewport: Rect.fromLTWH(322, 169, 505, 379),
  ),
  'autonomous/comfy-mcp': StoreCoverArt(
    asset: 'assets/store/covers/comfy-mcp.jpg',
    description: 'A landscape from ComfyUI’s area-composition example',
    credit: 'ComfyUI examples contributors',
    source:
        'https://comfyanonymous.github.io/ComfyUI_examples/area_composition/',
    license: 'ComfyUI examples permission notice',
    imageSize: Size(1088, 1920),
    viewport: Rect.fromLTWH(0, 538, 1088, 653),
  ),
  'autonomous/dimos': StoreCoverArt(
    asset: 'assets/store/covers/dimos.jpg',
    description: 'A spatial map from DimOS navigation',
    credit: 'Dimensional Inc.',
    source: 'https://github.com/dimensionalOS/dimos',
    license: 'Apache 2.0',
  ),
  'autonomous/simskill': StoreCoverArt(
    asset: 'assets/store/covers/simskill.png',
    description:
        'SimSkill’s connected library of simulation knowledge and skills',
    credit: 'SimSkill contributors',
    source: 'https://github.com/qiliuchn/SimSkill-V1',
    license: 'Apache 2.0',
    // Likewise, 4629 → 1600 wide. This one keeps its alpha (a cut-out on the
    // Store's own ground), so it stays a PNG and only loses the pixels no
    // screen was drawing.
    imageSize: Size(1600, 796),
    viewport: Rect.fromLTWH(8, 4, 656, 546),
  ),
  'autonomous/text-to-cad': StoreCoverArt(
    asset: 'assets/store/covers/text-to-cad.jpg',
    description: 'A planetary gear set from text-to-cad’s own preview',
    credit: 'Jake Adair · text-to-cad contributors',
    source: 'https://github.com/earthtojake/text-to-cad',
    license: 'MIT',
    imageSize: Size(1200, 630),
    viewport: Rect.fromLTWH(96, 217, 960, 296),
  ),
  'autonomous/home-assistant': StoreCoverArt(
    asset: 'assets/store/covers/home-assistant.jpg',
    description: 'Home Assistant’s public demo dashboard',
    credit: 'Home Assistant contributors',
    source: 'https://demo.home-assistant.io/',
    license: 'Apache 2.0 · demo UI',
    imageSize: Size(1440, 960),
    viewport: Rect.fromLTWH(537, 134, 878, 480),
  ),
  'autonomous/openscad': StoreCoverArt(
    asset: 'assets/store/covers/openscad.png',
    description:
        'A parametric impeller in OpenSCAD’s official application screenshot',
    credit: 'OpenSCAD contributors',
    source: 'https://openscad.org/',
    license: 'GPL 2.0 · application UI',
    imageSize: Size(800, 437),
    viewport: Rect.fromLTWH(416, 50, 372, 334),
  ),
  'autonomous/autonomous-circuit': StoreCoverArt(
    asset: 'assets/store/covers/autonomous-circuit.jpg',
    description:
        'A keyboard PCB rendered from Autonomous Circuit’s board model',
  ),
  'autonomous/autonomous-grid': StoreCoverArt(
    asset: 'assets/store/covers/autonomous-grid.jpg',
    description: 'Autonomous Grid’s map of models across machines',
    imageSize: Size(1440, 1100),
    viewport: Rect.fromLTWH(29, 33, 1008, 726),
  ),
  'autonomous/autoresearch-mlx': StoreCoverArt(
    asset: 'assets/store/covers/autoresearch-mlx.jpg',
    description:
        'The training curve in Harness’s Autoresearch research notebook',
    imageSize: Size(1280, 1000),
    viewport: Rect.fromLTWH(70, 225, 890, 360),
  ),
  'autonomous/circuitjs': StoreCoverArt(
    asset: 'assets/store/covers/circuitjs.jpg',
    description: 'An oscillating police-light circuit in CircuitJS',
    imageSize: Size(1600, 1000),
    viewport: Rect.fromLTWH(128, 135, 1296, 740),
  ),
  'autonomous/foam-agent': StoreCoverArt(
    asset: 'assets/store/covers/foam-agent.jpg',
    description: 'The interactive flow view in Harness’s wind tunnel',
    imageSize: Size(1280, 1015),
    viewport: Rect.fromLTWH(74, 228, 883, 381),
  ),
  'autonomous/godogen': StoreCoverArt(
    asset: 'assets/store/covers/godogen.jpg',
    description: 'Neon Drift: a playable game made with Godogen',
    imageSize: Size(1600, 1000),
    viewport: Rect.fromLTWH(29, 75, 1541, 860),
  ),
  'autonomous/juce-agent-toolkit': StoreCoverArt(
    asset: 'assets/store/covers/juce-agent-toolkit.jpg',
    description: 'The waveform and keyboard in Harness’s instrument maker',
    imageSize: Size(1280, 1000),
    viewport: Rect.fromLTWH(72, 225, 883, 400),
  ),
  'autonomous/harness-monitor': StoreCoverArt(
    asset: 'assets/store/covers/harness-monitor.jpg',
    description: 'Harness Monitor’s lanes with an illustrative demo fleet',
    imageSize: Size(1080, 720),
    viewport: Rect.fromLTWH(0, 0, 1080, 540),
    background: Color(0xff131312),
  ),
  'autonomous/machine-monitor': StoreCoverArt(
    asset: 'assets/store/covers/machine-monitor.jpg',
    description: 'Machine Monitor’s fleet view with an illustrative demo fleet',
    imageSize: Size(1360, 900),
    viewport: Rect.fromLTWH(90, 80, 875, 640),
    fit: BoxFit.contain,
    background: Color(0xff101113),
  ),
  'autonomous/marp': StoreCoverArt(
    asset: 'assets/store/covers/marp.jpg',
    description: 'A deep-sea keynote made with Marp',
    imageSize: Size(1600, 1000),
    viewport: Rect.fromLTWH(224, 150, 1248, 725),
  ),
  'autonomous/mlx-lm': StoreCoverArt(
    asset: 'assets/store/covers/mlx-lm.png',
    description:
        'MLX-LM in Harness’s local-model viewer, with a demo inventory',
  ),
  'autonomous/ollama': StoreCoverArt(
    asset: 'assets/store/covers/ollama.png',
    description:
        'Ollama in Harness’s local-model viewer, with a demo inventory',
  ),
  'autonomous/vllm': StoreCoverArt(
    asset: 'assets/store/covers/vllm.png',
    description: 'vLLM in Harness’s local-model viewer, with a demo inventory',
  ),
  'autonomous/orca-slicer': StoreCoverArt(
    asset: 'assets/store/covers/orca-slicer.jpg',
    description: 'A sliced part and its toolpaths in the Orca Slicer harness',
    imageSize: Size(1600, 1250),
    viewport: Rect.fromLTWH(104, 44, 1056, 525),
  ),
  'autonomous/score': StoreCoverArt(
    asset: 'assets/store/covers/score.jpg',
    description: 'An ensemble score made with Score',
    imageSize: Size(1600, 1100),
    viewport: Rect.fromLTWH(112, 280, 992, 671),
  ),
  'autonomous/yosys': StoreCoverArt(
    asset: 'assets/store/covers/yosys.jpg',
    description: 'Timing traces from a CPU built with Yosys',
    imageSize: Size(1600, 1000),
    viewport: Rect.fromLTWH(280, 135, 1296, 530),
  ),
};
