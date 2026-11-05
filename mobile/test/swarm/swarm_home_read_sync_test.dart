import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

// These tests drive Home, the real reader, and the project chat against an
// in-memory backend. Optional screenshots use the same data and assertions
// before and after the fix; no account or machine is contacted.
final shots = Platform.environment['SWARM_READ_SYNC_SHOTS'];

void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  const names = [
    'openharness',
    'radio',
    'computer',
    'harness-gtm',
    'pod',
    'lamp',
    'pcb',
    'design',
  ];
  final now = DateTime.utc(2026, 11, 5, 10);

  Map<String, dynamic> chat(String name, {int personSequence = 4}) => {
    ...groupData('chat-$name', title: name, lastMessageSequence: 9),
    'projectId': name,
    'lastMainSequence': 9,
    'lastPersonSequence': personSequence,
  };

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Design crew', 'ownerId': me},
      ],
      'next': null,
    };
    final load = firstLoad(
      head: headData(
        projects: [
          for (final name in names)
            {
              'id': name,
              'name': name,
              'ownerId': me,
              'leadConversationId': 'chat-$name',
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
        ],
      ),
      groups: [
        for (final name in names) ...[
          chat(name),
          {
            ...groupData('task-$name', lastMessageSequence: 12),
            'projectId': name,
            'lastMainSequence': 12,
            'lastPersonSequence': 0,
          },
        ],
      ],
      derived: {
        'readMarks': {for (final name in names) 'chat-$name': 1},
      },
    );
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...load,
      'groups': [
        for (final group in load['groups'] as List)
          {...group as Map, 'changedAt': now.millisecondsSinceEpoch},
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/chat-openharness/read'] = (
      body,
    ) => {'sequence': body!['sequence']};
    fake.routes['/api/super-tabs/$tab/conversations/chat-openharness/messages'] =
        (_) => {
          'messages': [
            {
              'id': 'person-message',
              'conversationId': 'chat-openharness',
              'sequence': 4,
              'author': {'kind': 'person', 'id': me, 'name': 'Dee'},
              'text': 'Please check the phone project rows.',
              'createdAt': now.toIso8601String(),
            },
            {
              'id': 'agent-message',
              'conversationId': 'chat-openharness',
              'sequence': 9,
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
              'text': 'The tests are ready for review.',
              'createdAt': now.toIso8601String(),
            },
          ],
          'next': null,
        };
    return fake;
  }

  Finder row(String name) => find.byKey(ValueKey('swarm-project-$tab-$name'));
  Finder inside(String name, String key) =>
      find.descendant(of: row(name), matching: find.byKey(ValueKey(key)));

  void expectRead(WidgetTester tester, String name) {
    expect(row(name), findsOneWidget);
    expect(inside(name, 'swarm-project-unread'), findsNothing);
    expect(
      tester.widget<Text>(inside(name, 'swarm-project-name')).style!.fontWeight,
      isNot(FontWeight.w600),
    );
  }

  for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
    for (final device in ['Desktop', 'phone']) {
      testWidgets('Home clears after reading on $device (${palette.name})', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(1170, 2532);
        tester.view.devicePixelRatio = 3;
        tester.view.padding = const FakeViewPadding(top: 141, bottom: 102);
        addTearDown(tester.view.reset);
        AppTheme.palette.value = palette;
        AppTheme.brightness.value = palette.brightness;
        addTearDown(() {
          AppTheme.palette.value = HarnessPalette.graphite;
          AppTheme.brightness.value = Brightness.dark;
        });
        final fake = backend();
        final account = ValueNotifier<String?>(me);
        final host = SwarmHost(
          accountId: () => me,
          account: account,
          request: fake.request,
          notices: SilentSystemNotices(),
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm},
          readMarks: MemoryKeyValueStore(),
        )..foreground = false;
        addTearDown(host.dispose);
        addTearDown(account.dispose);
        final boundary = GlobalKey();
        final navigator = GlobalKey<NavigatorState>();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              navigatorKey: navigator,
              debugShowCheckedModeBanner: false,
              theme: buildAppTheme(brightness: palette.brightness),
              builder: (_, child) => SwarmScope(notifier: host, child: child!),
              home: SwarmPage(now: () => now),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(inside('openharness', 'swarm-project-unread'), findsOneWidget);

        if (device == 'Desktop') {
          fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
            cursor: 'c3',
            // A poll carries whole changed groups and the remote marks.
            groups: [
              for (final name in names)
                {
                  ...part('chat-$name', 40, chat(name)),
                  'changedAt': now.millisecondsSinceEpoch,
                },
            ],
            derived: {
              'readMarks': {
                for (final name in names.where((n) => n != 'design'))
                  'chat-$name': 4,
              },
            },
          );
          await host.session!.inbox.reader(tab)!.refresh();
          await tester.pumpAndSettle();
        } else {
          await tester.tap(row('openharness'));
          await tester.pumpAndSettle();
          expect(
            find.text('Please check the phone project rows.'),
            findsOneWidget,
          );
          expect(
            fake.calls.where(
              (c) =>
                  c.method == 'POST' &&
                  c.path.endsWith('/chat-openharness/read') &&
                  (c.body?['sequence'] as int? ?? 0) >= 4,
            ),
            isNotEmpty,
          );
          navigator.currentState!.pop();
          await tester.pumpAndSettle();
        }

        // Capture before asserting so the failing baseline shows the bug.
        if (shots != null) {
          await tester.runAsync(() async {
            final image =
                await (boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 3);
            final png = await image.toByteData(format: ui.ImageByteFormat.png);
            await Directory(shots!).create(recursive: true);
            await File('$shots/home-$device-${palette.brightness.name}.png')
                .writeAsBytes(png!.buffer.asUint8List());
            image.dispose();
          });
        }
        expectRead(tester, 'openharness');
        if (device == 'Desktop') {
          for (final name in names.skip(1).where((n) => n != 'design')) {
            expectRead(tester, name);
          }
        }
        // A genuinely unread person's message still stands out.
        expect(inside('design', 'swarm-project-unread'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
