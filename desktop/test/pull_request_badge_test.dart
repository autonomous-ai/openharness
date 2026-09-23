import 'dart:ui' show PointerDeviceKind;

import 'package:harness/widgets/pane_header_actions.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/pull_request_badge.dart';

void main() {
  Widget frame(
    Object id,
    Future<Map<String, dynamic>> Function() read, {
    Future<bool> Function(Uri)? open,
  }) => MaterialApp(
    home: Scaffold(
      body: PullRequestBadge(identity: id, read: read, open: open),
    ),
  );
  testWidgets('PR remains clickable when hovering reveals header controls', (
    tester,
  ) async {
    var opened = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 500,
            child: PaneHeaderHover(
              child: PaneHeaderActions(
                zoomed: false,
                onZoom: () {},
                details: const Text('branch-name'),
                trailing: PullRequestBadge(
                  identity: 'branch',
                  read: () async => {
                    'status': 'found',
                    'number': 12,
                    'state': 'Open',
                    'url': 'https://github.com/acme/repo/pull/12',
                  },
                  open: (_) async {
                    opened = true;
                    return true;
                  },
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.text('PR #12 · Open')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('PR #12 · Open'));
    expect(opened, isTrue);
    await mouse.removePointer();
    await tester.pumpWidget(const SizedBox());
  });
  for (final state in ['Draft', 'Open', 'Merged', 'Closed']) {
    testWidgets('labels $state and opens the PR URL', (tester) async {
      Uri? opened;
      await tester.pumpWidget(
        frame(
          'branch',
          () async => {
            'status': 'found',
            'number': 12,
            'state': state,
            'url': 'https://github.com/acme/repo/pull/12',
          },
          open: (uri) async {
            opened = uri;
            return true;
          },
        ),
      );
      await tester.pump();
      await tester.tap(find.text('PR #12 · $state'));
      expect(opened.toString(), 'https://github.com/acme/repo/pull/12');
      await tester.pumpWidget(const SizedBox());
    });
  }
  testWidgets('none is hidden but failures are not called no PR', (
    tester,
  ) async {
    await tester.pumpWidget(frame('one', () async => {'status': 'none'}));
    await tester.pump();
    expect(find.byType(TextButton), findsNothing);
    await tester.pumpWidget(
      frame('two', () async => throw Exception('offline')),
    );
    await tester.pump();
    expect(find.text('PR unavailable'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
    'late result from a previous branch cannot overwrite current status',
    (tester) async {
      final old = Completer<Map<String, dynamic>>();
      await tester.pumpWidget(frame('old', () => old.future));
      await tester.pumpWidget(frame('new', () async => {'status': 'none'}));
      await tester.pump();
      old.complete({'status': 'unavailable'});
      await tester.pump();
      expect(find.text('PR unavailable'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
