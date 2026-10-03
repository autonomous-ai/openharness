import 'package:flutter/material.dart';

import '../daemons/illustrated_art.dart';
import '../daemons/roster.dart';
import '../daemons/zoo.dart';

/// Authored character fiction, kept separate from the individual's real history.
/// These are worlds to explore, never claims about work the person has done.
class CompanionStory {
  const CompanionStory(
    this.title,
    this.world,
    this.intro,
    this.story,
    this.promise,
    this.accent,
    this.motif,
  );

  final String title, world, intro, story, promise;
  final Color accent;
  final String motif;

  static CompanionStory of(String id) => stories[id] ?? stories['tim']!;

  static const stories = {
    'tim': CompanionStory(
      'Keeper of little beginnings',
      'The quiet tide',
      'Eight little arms. A whole world of possibility.',
      'In a quiet tide pool between one idea and the next, Tim gathers the '
          'things that might become something. A stray thought. An unfinished '
          'sentence. The courage to try again. There is an arm for each of them. '
          'And always one left for you.',
      'Every little thing you finish helps a little Tim grow.',
      Color(0xFFBDACE8),
      'tide',
    ),
    'gnu': CompanionStory(
      'A gentle, independent spirit',
      'The open meadow',
      'Big ideas need a little room to roam.',
      'GNU keeps a small clearing where every question is welcome. Beyond '
          'the long grass, paths branch in every direction. There is no single '
          'right way through the meadow. GNU will help you find one that feels '
          'like yours, then walk beside you.',
      'A patient companion for making things your own.',
      Color(0xFFE1B888),
      'meadow',
    ),
    'lynx': CompanionStory(
      'Finder of the almost invisible',
      'The lantern wood',
      'Some details only reveal themselves when you slow down.',
      'Lynx moves quietly through a wood full of little signals. A bent '
          'blade of grass. A glimmer behind a leaf. Where the path looks tangled, '
          'Lynx sees a thread worth following. Sit still together for a moment. '
          'The next clue might be closer than you think.',
      'For the small discoveries that change everything.',
      Color(0xFFE3B77C),
      'wood',
    ),
    'mutt': CompanionStory(
      'Deliverer of small joys',
      'The letter garden',
      'A little scruffy. Entirely on your side.',
      'There is a garden where all the unsent letters land. Mutt knows '
          'every corner of it. With a crooked ear and a very serious wag, '
          'this little courier carries the important things home: a hello, '
          'an answer, a reason to smile at the end of a long day.',
      'Good company has a way of finding you.',
      Color(0xFFD8AE8B),
      'garden',
    ),
    'yak': CompanionStory(
      'Friend of the scenic route',
      'The wandering hills',
      'Even a detour can become part of the story.',
      'Yak lives where the hills fold into clouds. There is always '
          'another interesting trail, another tiny thing to put right. '
          'Sometimes you need to wander. Sometimes you need a soft nudge '
          'back to the path. Yak is learning the difference alongside you.',
      'A little steadiness for your most winding days.',
      Color(0xFFC7BA9C),
      'hills',
    ),
    'gopher': CompanionStory(
      'Collector of useful wonders',
      'The little burrow',
      'Somewhere, there is just the thing you need.',
      'Under a small hill is a burrow lined with carefully labelled '
          'treasures. Gopher remembers which tunnel leads where, and which '
          'shelf holds the thing you nearly forgot. A rustle, a pop, and '
          'there it is. Finding things is nicer when someone is delighted to help.',
      'Small discoveries, brought into the light.',
      Color(0xFF8FCBD6),
      'burrow',
    ),
    'bug': CompanionStory(
      'Follower of tiny lights',
      'The midnight glow',
      'Curiosity is a small light that keeps moving.',
      'When the rest of the garden sleeps, Bug wakes. Every glowing '
          'window looks like a question waiting to be answered. Sometimes '
          'the light flickers. Sometimes the answer is surprising. Bug '
          'stays curious, circling back until the puzzling thing makes sense.',
      'For every “what if?” that keeps you looking.',
      Color(0xFFD5C78B),
      'glow',
    ),
    'tux': CompanionStory(
      'A warm heart in a cool world',
      'The starlit shore',
      'A steady little presence, whatever the weather.',
      'Tux keeps a lookout from a smooth stone beside the sea. The '
          'waves arrive, the waves depart, and some days the wind changes '
          'everything. Through it all, there is a familiar little face '
          'waiting on the shore, ready for whatever you build next.',
      'One small step, then another. Together.',
      Color(0xFF9EC5D9),
      'shore',
    ),
    'auk': CompanionStory(
      'Keeper of the well-chosen word',
      'The paper islands',
      'A whole idea can hide inside a little line.',
      'Auk tends a library scattered across tiny paper islands. '
          'Every shelf is a pattern, every bridge a connection. When '
          'the world feels too full of words, Auk finds the handful '
          'that matter and lays them gently in front of you.',
      'There is beauty in making something clear.',
      Color(0xFFB7C7D8),
      'islands',
    ),
    'beastie': CompanionStory(
      'A spark behind the scenes',
      'The ember hollow',
      'A little mischief. A lot of heart.',
      'Deep in the ember hollow, something is always quietly at work. '
          'Beastie tends the sparks with a tiny fork and an enormous sense '
          'of purpose. You might not notice every little thing running '
          'smoothly. Beastie does. That is part of the magic.',
      'For the invisible work that makes good things possible.',
      Color(0xFFE6A18F),
      'embers',
    ),
  };
}

String companionName(ZooDaemon daemon) =>
    daemon.name ?? IllustratedArt.name(daemon.id);

String companionAge(String version) => switch (version) {
  '2.0' => 'Grown companion',
  '1.0' => 'Young companion',
  _ => 'Little companion',
};

/// Growth uses the same roster thresholds as the zoo. A bond level is not
/// necessarily a visible growth stage (50 XP is a bond, 150 XP is young).
({int start, int target, String name})? nextCompanionGrowth(
  DaemonRoster roster,
  ZooDaemon daemon,
) {
  final levels = roster.rules.bondLevels;
  int xp(String version) => levels[roster.rules.bondForVersion[version]!];
  return switch (daemon.version) {
    '2.0' => null,
    '1.0' => (start: xp('1.0'), target: xp('2.0'), name: 'Grown companion'),
    _ => (start: 0, target: xp('1.0'), name: 'Young companion'),
  };
}
