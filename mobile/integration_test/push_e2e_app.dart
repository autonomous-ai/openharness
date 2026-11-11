import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart' show CurrentUserProfile;
import 'package:harness_mobile/notify/push_channel.dart';
import 'package:harness_mobile/notify/push_tokens.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../test/swarm/swarm_fixture.dart';

/// The phone app for the push end to end (task #3248, `push_e2e/run.sh`): the real [PhoneShell] with the
/// real notices ([LocalSystemNotices]) and the real push channel ([PushChannel]: `AppDelegate.swift`,
/// `MainActivity.kt`), signed in to a Swarm scripted in memory. A push the simulator is sent with the
/// app closed is drawn by iOS; its tap starts the app, which opens the thread its `link` names.
///
/// Nothing reaches an account, a machine or the backend: the Swarm is [FakeSwarm], the backend address
/// is a closed local port, and this phone's push address is never registered ([_NeverRegistered]).
///
///     flutter build ios --simulator --debug --target=integration_test/push_e2e_app.dart
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // XCUITest finds what is on screen by its semantics.
  WidgetsBinding.instance.ensureSemantics();
  // In memory only: the value, not the store's write.
  experimentalFeaturesStore.value = {PhoneExperiment.swarm};

  final notices = LocalSystemNotices();
  final app = _PushE2eApp(
    _swarm(),
    systemNotices: notices,
    pushTokens: _NeverRegistered(
      channel: PushChannel(),
      storage: _Memory(),
      allowed: () async => true,
    ),
  )..currentUser = const CurrentUserProfile(id: me, email: 'sam@example.com');
  // What the runner reads in the simulator's log: the push the tap opened.
  notices.openedSwarm.addListener(() {
    final target = notices.openedSwarm.value;
    if (target == null) return;
    debugPrint(
      'push-e2e: opened ${target.swarmId}/${target.conversationId} '
      'message ${target.messageId} thread ${target.threadId}',
    );
  });
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      home: PhoneShell(notifier: app),
    ),
  );
  // As Settings asks: the first launch's prompt, which the runner allows.
  unawaited(notices.requestPermission());
}

/// The Swarm the phone reads: chat "Onboarding copy" in project Mobile, where Sam asked something in
/// a thread (`m1`) and River and Nova replied in it. The push the runner sends is River's reply's.
FakeSwarm _swarm() {
  const chat = 'g1';
  Map<String, dynamic> message(
    String id,
    int sequence,
    String text, {
    required Map<String, dynamic> author,
    String? thread,
    int replies = 0,
  }) => {
    'id': id,
    'conversationId': chat,
    'text': text,
    'sequence': sequence,
    'replyTo': ?thread,
    'thread': ?thread,
    if (replies > 0) 'replyCount': replies,
    'author': author,
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 5, 9, sequence).toIso8601String(),
  };
  const sam = {'kind': 'person', 'id': me, 'name': 'Sam'};
  const river = {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'};
  const nova = {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'};
  final root = message(
    'm1',
    1,
    'Who can draft the onboarding copy for the three welcome screens?',
    author: sam,
    replies: 2,
  );

  const path = '/api/super-tabs/$tab';
  final fake = FakeSwarm();
  fake.routes['/api/super-tabs/list'] = (_) => {
    'tabs': [
      {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
    ],
    'next': null,
  };
  fake.routes['$path/parts'] = (_) => firstLoad(
    groups: [
      groupData(
        chat,
        title: 'Onboarding copy',
        agentIds: ['agent-lead', 'agent-builder'],
        lastMessageSequence: 3,
      ),
    ],
  );
  fake.routes['$path/changes'] = (_) => changes(cursor: 'c2');
  fake.routes['$path/decisions'] = (_) => {'decisions': <Object>[]};
  fake.routes['$path/mentions'] = (_) => {'mentions': <Object>[]};
  fake.routes['$path/activity'] = (_) => {'items': <Object>[]};
  fake.routes['$path/commands'] = (_) => <String, dynamic>{'result': {}};
  // Whatever else a screen reads: nothing there.
  fake.routes['$path/'] = (_) => <String, dynamic>{
    'messages': <Object>[],
    'next': null,
  };
  fake.routes['$path/conversations/$chat/messages'] = (_) => {
    'messages': [root],
    'next': null,
  };
  fake.routes['$path/conversations/$chat/messages?thread=m1'] = (_) => {
    'messages': [
      message(
        'r3',
        3,
        'I can take the third screen once the first two land.',
        author: nova,
        thread: 'm1',
      ),
      message(
        'r2',
        2,
        'Drafted the first two screens: short, one idea each.',
        author: river,
        thread: 'm1',
      ),
    ],
  };
  return fake;
}

class _PushE2eApp extends AppNotifier {
  _PushE2eApp(this._fake, {super.systemNotices, super.pushTokens})
    : super(
        // A closed local port: anything that is not the scripted Swarm fails here, at once.
        config: const AppConfig(apiBaseUrl: 'http://127.0.0.1:9'),
        authSession: AuthSession(storage: _Memory()),
        configStore: null,
      );

  final FakeSwarm _fake;

  @override
  Future<Object?> swarmRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) => _fake.request(method, path, body: body);
}

/// The real push channel, whose address is never sent anywhere.
class _NeverRegistered extends PushTokens {
  _NeverRegistered({
    required super.channel,
    required super.storage,
    required super.allowed,
  });

  @override
  Future<void> sync({
    required String account,
    required PushTokenApi api,
    required bool Function() current,
  }) async {}
}

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}
