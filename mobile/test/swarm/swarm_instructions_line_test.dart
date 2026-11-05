import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';

/// An instructions save's line in the project chat shows what it changed and
/// opens the revision it saved (Ken, 11-05, #3021).
void main() {
  Widget row(
    Map<String, dynamic> source,
    void Function(({String projectId, int revision}))? open,
  ) => MaterialApp(
    home: Scaffold(
      body: ListView(
        children: [
          SwarmMessageRow(
            message: SuperTabMessage.fromJson({
              'id': 'saved',
              'conversationId': 'lead',
              'text':
                  'owner changed the instructions: Reviews run on Opus.\n\n'
                  'In Routing › Models:\nRemoved: Haiku reviews.\n'
                  'Added: Opus reviews.\n\nand 3 more changes.',
              'sequence': 1,
              'author': {'kind': 'person', 'id': 'owner', 'name': 'owner'},
              'createdAt': DateTime.utc(2026, 11, 5).toIso8601String(),
              'source': source,
            }),
            name: 'owner',
            look: (picture: null, status: null),
            role: null,
            mentions: SwarmMentions(const []),
            grouped: false,
            lit: false,
            quote: null,
            actions: false,
            onTap: () {},
            onReply: null,
            onOpenInstructions: open,
          ),
        ],
      ),
    ),
  );

  testWidgets('shows the change and opens the revision it saved', (
    tester,
  ) async {
    final opened = <({String projectId, int revision})>[];
    await tester.pumpWidget(
      row({
        'kind': 'instructions',
        'projectId': 'p1',
        'revision': 8,
      }, opened.add),
    );
    expect(find.textContaining('Removed: Haiku reviews.'), findsOneWidget);
    expect(find.textContaining('and 3 more changes.'), findsOneWidget);
    await tester.tap(find.text('See revision 8'));
    expect(opened, [(projectId: 'p1', revision: 8)]);
  });

  testWidgets('no link on any other line', (tester) async {
    await tester.pumpWidget(row({'kind': 'ship'}, (_) {}));
    expect(find.textContaining('See revision'), findsNothing);
    await tester.pumpWidget(row({'kind': 'instructions'}, (_) {}));
    expect(find.textContaining('See revision'), findsNothing);
  });
}
