import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../swarm/swarm_fixture.dart';
import '../voice_fakes.dart';

/// Renders a phone Swarm chat's threads as Tony's mockup of 10-29 draws them —
/// the chat with a root's "N replies" line, a reply also sent and Reply in
/// thread, then the thread itself — in light and dark, at iPhone 14 size in
/// the system fonts, to PNGs a reviewer can look at without a phone.
/// Scripted data only.
///
/// Skipped unless PHONE_RENDER_DIR names a directory to write into:
///
///     PHONE_RENDER_DIR=/tmp/renders flutter test test/render/swarm_thread_render_test.dart
///
/// macOS only: it loads SF Pro and SF Mono from /System/Library/Fonts.
final _outDir = Platform.environment['PHONE_RENDER_DIR'];

Future<void> _loadFonts() async {
  Future<void> load(String family, String file) async {
    final bytes = await File('/System/Library/Fonts/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
    await load(family, 'SFNS.ttf');
  }
  for (final family in ['.AppleSystemUIFontMonospaced', 'SF Mono']) {
    await load(family, 'SFNSMono.ttf');
  }
  // The icons, from the package in the pub cache.
  final lucide =
      '${Platform.environment['HOME']}/.pub-cache/hosted/pub.dev/lucide_icons_flutter-3.1.19/assets';
  Future<void> icons(String family, String file) async {
    final bytes = await File('$lucide/$file').readAsBytes();
    await (FontLoader(
      family,
    )..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
  }

  await icons('packages/lucide_icons_flutter/Lucide', 'lucide.ttf');
  for (final weight in [100, 200, 300, 400, 500, 600]) {
    await icons(
      'packages/lucide_icons_flutter/Lucide$weight',
      'build_font/LucideVariable-w$weight.ttf',
    );
  }
}

void main() {
  final skip = _outDir == null;
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  FakeSwarm backend() {
    final now = DateTime.now().toUtc();
    Map<String, dynamic> message(
      String id,
      int sequence,
      String text, {
      required String author,
      required int minutesAgo,
      String? thread,
      bool alsoInChat = false,
    }) => {
      'id': id,
      'conversationId': 'g1',
      'text': text,
      'sequence': sequence,
      'thread': thread ?? id,
      'replyTo': ?thread,
      if (alsoInChat) 'alsoInChat': true,
      'author': author == me
          ? {'kind': 'person', 'id': me, 'name': 'tony'}
          : {
              'kind': 'agent',
              'id': author,
              'name': author == 'agent-lead' ? 'River' : 'Nova',
            },
      'attachments': <Object>[],
      'reactions': <Object>[],
      'createdAt': now
          .subtract(Duration(minutes: minutesAgo))
          .toIso8601String(),
    };

    final page = [
      message(
        'm1',
        1,
        'Can you check the drawer mockup?',
        author: 'agent-lead',
        minutesAgo: 20,
      ),
      message(
        'm2',
        2,
        'Looks good. One question on the bold names.',
        author: 'agent-builder',
        minutesAgo: 18,
        thread: 'm1',
      ),
      message(
        'm3',
        3,
        'Ship it as drawn.',
        author: me,
        minutesAgo: 17,
        thread: 'm1',
      ),
      message(
        'm4',
        4,
        'Pushed the fix.',
        author: 'agent-builder',
        minutesAgo: 5,
        thread: 'm1',
        alsoInChat: true,
      ),
      message(
        'm5',
        5,
        'Next: the leaderboard.',
        author: 'agent-builder',
        minutesAgo: 4,
      ),
    ];
    final line = {
      'id': 'm1',
      'replies': 3,
      'lastSequence': 4,
      'lastAt': now.subtract(const Duration(minutes: 5)).toIso8601String(),
      'authors': [
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
        {'kind': 'person', 'id': me, 'name': 'tony@example.com'},
      ],
      'people': [me],
    };

    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Mobile: bold names and @N',
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            lastMessageSequence: 5,
          ),
        ],
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': null,
      'threads': [line],
    };
    fake.routes['$messages?thread=m1'] = (_) => {
      'messages': [
        for (final m in page.reversed)
          if (m['thread'] == 'm1') m,
      ],
      'next': null,
      'threads': [line],
    };
    return fake;
  }

  Future<void> shoot(WidgetTester tester, GlobalKey key, String name) async {
    await tester.runAsync(() async {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final file = File('$_outDir/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(png!.buffer.asUint8List());
    });
  }

  for (final brightness in Brightness.values) {
    final look = brightness.name;

    Future<GlobalKey> chat(WidgetTester tester) async {
      await tester.runAsync(_loadFonts);
      // A palette carries its brightness: a light one is how the app goes light.
      final palette = HarnessPalette.values.firstWhere(
        (p) => p.brightness == brightness,
      );
      final previous = (
        grid.AppTheme.brightness.value,
        grid.AppTheme.palette.value,
      );
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() {
        grid.AppTheme.brightness.value = previous.$1;
        grid.AppTheme.palette.value = previous.$2;
      });
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      tester.view.viewPadding = const FakeViewPadding(
        top: 47 * 3,
        bottom: 34 * 3,
      );
      addTearDown(tester.view.reset);

      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: features,
      )..foreground = false;
      addTearDown(host.dispose);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: grid.BrightnessScope(
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) =>
                  SwarmScope(notifier: host, child: child!),
              home: const SwarmConversationPage(
                swarmId: tab,
                conversationId: 'g1',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return key;
    }

    testWidgets(
      'the chat: a replies line, a reply also sent, Reply in '
      'thread ($look)',
      skip: skip,
      (tester) async {
        final key = await chat(tester);
        await tester.tap(find.text('Next: the leaderboard.'));
        await tester.pumpAndSettle();
        await shoot(tester, key, 'swarm-thread-chat-$look');
      },
    );

    testWidgets('the thread ($look)', skip: skip, (tester) async {
      final key = await chat(tester);
      await tester.tap(find.byKey(const ValueKey('swarm-thread-line-m1')));
      await tester.pumpAndSettle();
      await shoot(tester, key, 'swarm-thread-open-$look');
    });
  }
}
