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
  });

  final String asset;
  final String description;
  final String? credit;
  final String? source;
  final String? license;
  final Alignment alignment;
  final BoxFit fit;
  final Color? background;
  final double scale;
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
    asset: 'assets/store/covers/kicad.png',
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
    asset: 'assets/store/covers/mujoco.png',
    description: 'A Unitree G1 robot rendered in MuJoCo Menagerie',
    credit: 'MuJoCo Menagerie · Unitree Robotics',
    source: 'https://github.com/google-deepmind/mujoco_menagerie/tree/main/unitree_g1',
    license: 'BSD 3-Clause',
    fit: BoxFit.contain,
    background: Color(0xff253f57),
  ),
  'autonomous/marimo': StoreCoverArt(
    asset: 'assets/store/covers/marimo.png',
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
    asset: 'assets/store/covers/generative-art.png',
    description: 'Canopy: a generative artwork made with Harness',
  ),
  'autonomous/voxel-worlds': StoreCoverArt(
    asset: 'assets/store/covers/voxel-worlds.jpg',
    description: 'Amber Vault: a world made with Voxel Worlds',
  ),
  'autonomous/music-studio': StoreCoverArt(
    asset: 'assets/store/covers/music-studio.png',
    description: 'Keepsake: a composition in Music Studio',
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
  ),
  'autonomous/jev-sheets': StoreCoverArt(
    asset: 'assets/store/covers/jev-sheets.jpg',
    description: 'A typed column in Jev Sheets',
    alignment: Alignment.topCenter,
  ),
  'autonomous/roundtable': StoreCoverArt(
    asset: 'assets/store/covers/roundtable.jpg',
    description: 'Roundtable’s map of agreement and disagreement',
    alignment: Alignment.topCenter,
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
};
