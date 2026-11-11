import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';

import 'keymap_host_test.dart' show MemoryKeymap;

void main() {
  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.linux,
    TargetPlatform.windows,
  ]) {
    test(
      'the unread chat keys are Swarm chat commands on ${platform.name}',
      () {
        debugDefaultTargetPlatformOverride = platform;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        final down = KeyStroke.parse('alt+shift+down');
        final up = KeyStroke.parse('alt+shift+up');
        expect(
          harnessDefaultKeymap.match(KeymapContext.swarmChat, [down]).command,
          'swarm.next_unread',
        );
        expect(
          harnessDefaultKeymap.match(KeymapContext.swarmChat, [up]).command,
          'swarm.previous_unread',
        );
        // A pane keeps what it had: Move pane where Alt is the workspace key.
        final pane = harnessDefaultKeymap.match(KeymapContext.terminal, [
          down,
        ]).command;
        expect(pane, isNot('swarm.next_unread'));
        if (platform == TargetPlatform.linux) expect(pane, 'pane.move_down');
      },
    );
  }

  test('Keyboard shortcuts lists both unread chat keys', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final lessons = {
      for (final lesson in keyboardLessons(map)) lesson.command: lesson,
    };
    for (final (id, label, key) in [
      ('swarm.next_unread', 'Next unread chat', 'alt+shift+down'),
      ('swarm.previous_unread', 'Previous unread chat', 'alt+shift+up'),
    ]) {
      final lesson = lessons[id];
      expect(lesson, isNotNull, reason: id);
      expect(lesson!.label, label);
      expect(lesson.context, KeymapContext.swarmChat);
      expect(lesson.bindings.map((b) => b.sequence), [key]);
    }
  });
}
