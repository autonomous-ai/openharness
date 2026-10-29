import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_buddy.dart';

/// The Swarm models the phone carries as copies of the desktop's
/// (`../desktop/lib/super_tabs`): phone path → desktop path. The phone is a
/// standalone package (README), so it cannot import them.
///
/// ⚠️ A fix made to one side only fails nowhere else: a field the backend adds
/// would parse on a computer and be dropped on the phone. Here a drift fails
/// until the change is carried across — or, if the two are meant to differ now,
/// until the file leaves this list on purpose.
const _copies = {
  'lib/swarm/parts.dart': 'lib/super_tabs/parts.dart',
  'lib/swarm/profile_model.dart': 'lib/super_tabs/profile_model.dart',
};

/// The phone's model is ahead of main's desktop copy, so it is no exact copy
/// for now: it also keeps a read's lookups by id, cached once per read, and
/// each conversation's reaction counter (`reactionSeq`), which the phone's
/// chat needs and the desktop's model has not taken yet (the phone line,
/// merged into main without its desktop changes, 10-29). It still reads
/// every field the desktop's does, so nothing the backend adds is parsed on
/// a computer and dropped on the phone. Back in [_copies] once the desktop's
/// model carries them.
///
/// Chat threads (#2132), PM ruling 10-29: the phone has no thread view yet,
/// so a reply only in its thread stays in the chat, inline, and nothing is
/// lost; but unread and bold follow the desktop's main-stream rule
/// (`lastMainSequence`, [SuperTabConversation.mainSequence]), so a reply only
/// in its thread makes a chat unread on neither. The phone reads a message's
/// thread and the thread summaries as the desktop does, and shows none yet.
const _model = ('lib/swarm/model.dart', 'lib/super_tabs/model.dart');

void main() {
  test("${_model.$1} reads every field the desktop's ${_model.$2} reads", () {
    final reads = RegExp(
      r"(?:row|start|json)\['(\w+)'\]|_text\(row, '(\w+)'\)",
    );
    Set<String> fields(String path) => {
      for (final m in reads.allMatches(File(path).readAsStringSync()))
        (m.group(1) ?? m.group(2))!,
    };
    final desktop = fields('../desktop/${_model.$2}');
    expect(desktop, isNotEmpty);
    expect(desktop.difference(fields(_model.$1)), isEmpty);
  });

  test(
    'a Buddy engine the server refuses is refused in the desktop\'s words',
    () {
      // The backend checks the desktop's words against its own refusal
      // (buddies.test.ts); the phone shows the same beside a turned-off engine.
      final desktop = File('../desktop/lib/super_tabs/buddies.dart')
          .readAsStringSync();
      final refusals = RegExp(
        r"kBuddyEngineRefusals = \{\s*((?:'\w+':\s*'[^']*',\s*)*)\}",
      ).firstMatch(desktop)!.group(1)!;
      expect(swarmBuddyEngineRefusals, {
        for (final m in RegExp(r"'(\w+)':\s*'([^']*)'").allMatches(refusals))
          m.group(1)!: m.group(2)!,
      });
    },
  );

  for (final MapEntry(key: phone, value: desktop) in _copies.entries) {
    test("$phone matches the desktop's $desktop", () {
      final source = File('../desktop/$desktop');
      if (!source.existsSync()) {
        throw StateError(
          '${source.path} missing — run from mobile/ in the monorepo',
        );
      }
      final copy = File(phone);
      expect(copy.existsSync(), isTrue, reason: '$phone is missing');
      expect(
        copy.readAsStringSync(),
        source.readAsStringSync(),
        reason:
            'carry the change to both copies (or drop the pair from '
            'test/swarm/desktop_parity_test.dart if they are meant to differ)',
      );
    });
  }
}
