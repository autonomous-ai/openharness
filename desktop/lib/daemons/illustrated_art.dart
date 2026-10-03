/// Bundled, code-drawn artwork. This adapter never changes zoo state or asks
/// harnessd for a plate. Its keys are shared by Flutter and the native tab bar.
library;

import 'daemon_face.dart';
import 'illustrated_alignment.g.dart';
import 'roster.dart';
import 'individuals.dart';
import 'illustrated_styles.g.dart';

class IllustratedArt {
  const IllustratedArt._(
    this.stem,
    this.frames, {
    this.colour = -1,
    this.mark = 0,
  });
  final int colour, mark;
  Map<String, int> get style => {'colour': colour, 'mark': mark};
  bool get styled => colour >= 0 || mark > 0;
  int get frameMs {
    final parts = stem.split('_');
    final table = illustratedStyles[parts.first]?['timing'] as List?;
    final mood = parts.length > 2
        ? (parts[2] == 'back' ? 'done' : parts[2])
        : '';
    final index = const [
      'idle',
      'work',
      'need',
      'done',
      'fail',
      'nap',
      'boop',
    ].indexOf(mood);
    return table == null || index < 0
        ? 190
        : (table[index] as int).clamp(80, 600);
  }

  static const species = [
    'tim',
    'gnu',
    'lynx',
    'mutt',
    'yak',
    'gopher',
    'bug',
    'tux',
    'auk',
    'beastie',
  ];

  static bool supports(String? id) => species.contains(id);
  static String name(String id) =>
      id == 'gnu' ? 'GNU' : '${id[0].toUpperCase()}${id.substring(1)}';

  static const daemonFrames = {
    'idle': 4,
    'work': 4,
    'need': 4,
    'done': 4,
    'fail': 1,
    'nap': 4,
    'back': 4,
    'boop': 4,
    'blink': 1,
  };
  static const timFrames = daemonFrames;
  static const eggFrames = {
    'p0': 4,
    'p1': 1,
    'p2': 1,
    'p3': 1,
    'p4': 4,
    'rock': 4,
    'burst': 4,
    'tumble': 4,
    'open': 1,
    'hatchling': 4,
  };
  static const eggKinds = {
    'first',
    'setup',
    'turn',
    'week',
    'marathon',
    'night',
    'history',
    'easter',
  };

  factory IllustratedArt.tim({
    String version = '0.1',
    DaemonMood mood = DaemonMood.idle,
    bool blink = false,
  }) =>
      IllustratedArt.daemon('tim', version: version, mood: mood, blink: blink);

  factory IllustratedArt.daemon(
    String species, {
    String version = '0.1',
    DaemonMood mood = DaemonMood.idle,
    bool blink = false,
    DaemonTraits? traits,
  }) {
    if (!supports(species)) throw ArgumentError.value(species, 'species');
    final age = switch (version) {
      '1.0' => 'young',
      '2.0' => 'adult',
      _ => 'baby',
    };
    final expression = blink && mood != DaemonMood.nap ? 'blink' : mood.name;
    final styles = illustratedStyles[species]!;
    final colour = traits == null || traits.seed == 0
        ? -1
        : (styles['colours'] as List).indexOf(traits.colour);
    final mark = traits == null || traits.seed == 0
        ? 0
        : (styles['marks'] as List).indexOf(traits.marks).clamp(0, 4);
    return IllustratedArt._(
      '${species}_${age}_$expression',
      daemonFrames[expression]!,
      colour: colour,
      mark: mark,
    );
  }

  factory IllustratedArt.egg({String kind = 'first', String stage = 'p0'}) {
    final shell = eggKinds.contains(kind) ? kind : 'first';
    final phase = eggFrames.containsKey(stage) ? stage : 'p0';
    return IllustratedArt._('egg_${shell}_$phase', eggFrames[phase]!);
  }

  final String stem;
  final int frames;
  bool get finite =>
      stem.endsWith('_done') ||
      stem.endsWith('_boop') ||
      stem.endsWith('_back');

  /// Optical centre of the registered idle pose, in source pixels. All frames
  /// keep this same anchor so breathing, jumps and hatching don't get recentered
  /// frame by frame. Matches SwarmDaemonArt in the native tab bar.
  (double, double) center({bool slot = false}) {
    final key = stem.split('_').take(2).join('_');
    final center = illustratedArtCenters[key]!;
    return slot ? (center.$1, center.$2) : (center.$3, center.$4);
  }

  String asset(int frame, {bool slot = false}) =>
      'assets/daemon-art/${slot ? 'slot' : 'portrait'}/${stem}_${frame % frames}.png';

  static IllustratedArt? forFace(DaemonFace face) {
    if (!face.visible) return null;
    if (face.showsDaemon) {
      if (!supports(face.def?.id)) return null;
      return IllustratedArt.daemon(
        face.def!.id,
        version: face.daemon!.version,
        mood: face.mood,
        blink: face.lid != null,
        traits: face.traits,
      );
    }
    final egg = face.eggArtwork;
    return egg == null ? null : IllustratedArt.egg(kind: egg.$1, stage: egg.$2);
  }

  static int frameForFace(DaemonFace face) => face.artFrame;
}
