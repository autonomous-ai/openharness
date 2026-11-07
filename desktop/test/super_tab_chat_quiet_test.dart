import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/avatar_art.dart';
import 'package:harness/super_tabs/message_row.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

/// Task #4467 (anh Dee, 11-07 15:35): the Swarm chat, quiet. Round faces at 28, the name in semibold, the time in
/// 12 tertiary, text at 14, and a composer that matches Cmd-N.
void main() {
  group('a message row', () {
    /// A person, an agent in the Swarm, and an agent that has left, one message each.
    ConversationServer server() {
      final server = ConversationServer();
      (server.state['agents'] as List).add({
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'River',
        'machineId': 'mac',
        'harnessId': 'h-pm',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      });
      server.append('From a person');
      server.append('From an agent', agent: true);
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'pm',
        'name': 'Lead',
      };
      server.append('From a person again');
      server.append('From an agent that left', agent: true);
      return server;
    }

    for (final brightness in Brightness.values) {
      testWidgets('draws every sender as a round face at 28 '
          '(${brightness.name})', (tester) async {
        await showView(tester, server(), brightness: brightness);
        final faces = find.descendant(
          of: find.byType(SuperTabMessageRow),
          matching: find.byType(SuperTabAvatarFace),
        );
        expect(faces, findsNWidgets(4));
        for (final face in faces.evaluate()) {
          final widget = face.widget as SuperTabAvatarFace;
          expect(widget.radius, isNull, reason: 'round, not a rounded square');
          expect(tester.getSize(find.byWidget(widget)), const Size(28, 28));
        }
      });
    }
  });
}
