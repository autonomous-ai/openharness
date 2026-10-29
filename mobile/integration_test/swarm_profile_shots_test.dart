import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_face.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../test/swarm/swarm_fixture.dart';
import '../test/voice_fakes.dart' show MemoryKeyValueStore;

/// Avatars, status and the profile sheet on a simulator, a screenshot at
/// each step, in the dark theme and then the light one: a chat with each
/// author's face and a status, a person's sheet, the profile sheet, the menu's
/// "You" row and the project page's work.
///
/// Every answer is scripted in memory ([FakeSwarm]) and the uploaded photo is
/// drawn here: nothing reaches an account, a machine or the backend.
///
///     flutter drive -d <simulator> --driver=test_driver/journey_driver.dart \
///       --target=integration_test/swarm_profile_shots_test.dart
///
/// Screenshots land in `HARNESS_JOURNEY_OUT` (default `build/journey/`).
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  for (final palette in [HarnessPalette.graphite, HarnessPalette.mist]) {
    final theme = palette.isDark ? 'dark' : 'light';
    testWidgets('avatars and status, $theme', (tester) async {
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      final walk = _Walk(tester, binding, 'profile-$theme');
      final photo = await tester.runAsync(_photo);
      final host = _host(_backend());
      addTearDown(host.dispose);

      await tester.pumpWidget(
        _app(
          host,
          photo!,
          palette,
          const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
        ),
      );
      await walk.waitFor(walk.key('swarm-message-m3'));
      await walk.decode();
      await walk.shot('chat');

      await tester.tap(walk.key('swarm-author-m1'));
      await walk.shot('person');
      await tester.tapAt(const Offset(200, 120));
      await walk.wait();

      await tester.tap(walk.key('swarm-author-m3'));
      await walk.wait();
      await tester.tap(walk.key('swarm-person-edit'));
      await walk.shot('profile');
      await tester.drag(
        find.byType(SingleChildScrollView).last,
        const Offset(0, -500),
      );
      await walk.shot('profile-status');
      await tester.tap(walk.key('swarm-status-☕'));
      await walk.wait(300);
      await tester.tap(walk.key('swarm-status-clears-hour'));
      await walk.shot('profile-status-chosen');

      await tester.pumpWidget(
        _app(host, photo, palette, const SwarmPage()),
      );
      await walk.wait(1500);
      await tester.tap(walk.key('swarm-menu'));
      await walk.shot('menu');

      await tester.pumpWidget(
        _app(
          host,
          photo,
          palette,
          const SwarmProjectPage(swarmId: tab, projectId: project),
        ),
      );
      await walk.decode();
      await walk.shot('project');
    });
  }
}

/// A photo as one would upload: a warm gradient with a sun in it.
Future<Uint8List> _photo() async {
  const side = 256.0;
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    const ui.Rect.fromLTWH(0, 0, side, side),
    ui.Paint()
      ..shader = ui.Gradient.linear(
        const ui.Offset(0, 0),
        const ui.Offset(side, side),
        const [ui.Color(0xFFFFB347), ui.Color(0xFFD9488B)],
      ),
  );
  canvas.drawCircle(
    const ui.Offset(side * .62, side * .38),
    side * .18,
    ui.Paint()..color = const ui.Color(0xFFFFF1C1),
  );
  final image = await recorder.endRecording().toImage(256, 256);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return bytes!.buffer.asUint8List();
}

const _tony = 'person-tony';
const _photoLink = 'https://storage.googleapis.com/avatars/river.png?sig=1';

FakeSwarm _backend() {
  final fake = FakeSwarm();
  final now = DateTime.now().toUtc();
  var me_ = <String, dynamic>{
    ...person(me),
    'email': 'ken@autonomous.ai',
    'avatar': {'kind': 'preset', 'key': 'fox'},
    'status': {
      'text': 'Focusing',
      'emoji': '🎯',
      'until': now.add(const Duration(hours: 2)).toIso8601String(),
    },
  };
  final derived = {
    'avatars': {'agent:agent-lead': _photoLink},
  };
  Map<String, dynamic> members() => {
    'members': [
      part(me, 1, me_),
      part(_tony, 1, {
        ...person(_tony, role: 'collaborator'),
        'email': 'tony@autonomous.ai',
        'status': {'text': 'At lunch', 'emoji': '🍽️', 'until': null},
      }),
    ],
  };
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
  fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
    ...firstLoad(
      derived: derived,
      agents: [
        {
          ...agent('agent-lead', name: 'Lead', displayName: 'River'),
          'avatar': {'kind': 'upload'},
        },
        {
          ...agent('agent-builder', displayName: 'Nova'),
          'avatar': {'kind': 'preset', 'key': 'owl'},
        },
        agent('agent-pike', displayName: 'Pike'),
      ],
      groups: [
        groupData(
          'g1',
          title: 'Avatars on the phone',
          number: 509,
          agentIds: ['agent-lead', 'agent-builder'],
          status: 'working',
          lastMessageSequence: 3,
        ),
        groupData(
          'g2',
          title: 'Reactions',
          number: 510,
          agentIds: ['agent-pike'],
          status: 'working',
          workerId: 'agent-pike',
        ),
      ],
    ),
    ...members(),
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
    ...changes(cursor: 'c2', derived: derived),
    ...members(),
  };
  fake.routes['/api/super-tabs/$tab/groups'] = (_) => {
    'groups': <Object>[],
    'next': null,
  };
  fake.routes['/api/super-tabs/$tab/commands'] = (body) {
    final command = body!['command'] as Map<String, dynamic>;
    if (command['type'] == 'member.status') {
      me_ = {...me_..remove('status'), 'status': ?command['status']};
    }
    return {'ok': true};
  };
  Map<String, dynamic> message(
    String id,
    int sequence,
    String text,
    Map<String, dynamic> author,
  ) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'author': author,
    'attachments': <Object>[],
    'createdAt': now
        .subtract(Duration(minutes: 10 - sequence))
        .toIso8601String(),
  };
  fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
    'messages': [
      message('m1', 1, 'Can the phone show our pictures yet?', {
        'kind': 'person',
        'id': _tony,
        'name': 'tony@autonomous.ai',
      }),
      message(
        'm2',
        2,
        'Yes: photos, built-in pictures, and a status beside your face.',
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      ),
      message('m3', 3, 'Great, trying it now.', {
        'kind': 'person',
        'id': me,
        'name': 'ken@autonomous.ai',
      }),
    ],
    'next': null,
  };
  return fake;
}

SwarmHost _host(FakeSwarm fake) {
  final account = ValueNotifier<String?>(me);
  return SwarmHost(
    accountId: () => account.value,
    account: account,
    request: fake.request,
    notices: SilentSystemNotices(),
    features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm},
    uploadAvatar: ({required tabId, required png}) async => 'upload-1',
  )..foreground = false;
}

/// [home] in [palette], with [host]'s Swarm over it and [photo] as every
/// uploaded picture.
Widget _app(
  SwarmHost host,
  Uint8List photo,
  HarnessPalette palette,
  Widget home,
) {
  final image = MemoryImage(photo);
  return grid.BrightnessScope(
    child: MaterialApp(
      // A new app per screen: no sheet of the last one stays open over it.
      key: ValueKey(home.runtimeType),
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: palette.brightness),
      builder: (context, child) => SwarmScope(
        notifier: host,
        child: SwarmAvatarImages(image: (_) => image, child: child!),
      ),
      home: home,
    ),
  );
}

class _Walk {
  _Walk(this.tester, this.binding, this.name);

  final WidgetTester tester;
  final IntegrationTestWidgetsFlutterBinding binding;
  final String name;
  var _step = 0;

  Future<void> wait([int ms = 600]) async {
    for (var elapsed = 0; elapsed < ms; elapsed += 100) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  /// Lets pictures decode, which happens outside the test's frames.
  Future<void> decode() async {
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pump();
    }
  }

  Future<void> shot(String step, {int settle = 900}) async {
    await wait(settle);
    _step++;
    await binding.takeScreenshot(
      '$name-${_step.toString().padLeft(2, '0')}-$step',
    );
  }

  Future<void> waitFor(Finder finder, {int seconds = 20}) async {
    for (var i = 0; i < seconds * 10; i++) {
      if (finder.evaluate().isNotEmpty) return;
      await tester.pump(const Duration(milliseconds: 100));
    }
    fail('never appeared: $finder');
  }

  Finder key(String value) => find.byKey(ValueKey(value));
}
