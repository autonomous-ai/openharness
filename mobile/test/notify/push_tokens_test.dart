import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart' show ApiException;
import 'package:harness_mobile/notify/push_channel.dart';
import 'package:harness_mobile/notify/push_tokens.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

/// What the backend is told of this phone's push address, and when: once per address and account,
/// again each week, never for a phone whose person refused notices or signed out — and a phone that
/// signed out is reached by nothing, even when the backend could not be told.
void main() {
  const ios = (token: 'apns-1', platform: 'ios');

  late _Channel channel;
  late _Api api;
  late MemoryKeyValueStore storage;
  late DateTime now;
  bool? allowed;
  late PushTokens push;

  setUp(() {
    channel = _Channel()..next = ios;
    api = _Api();
    storage = MemoryKeyValueStore();
    now = DateTime(2026, 11, 5, 9);
    allowed = true;
    push = PushTokens(
      channel: channel,
      storage: storage,
      allowed: () async => allowed,
      now: () => now,
    );
  });

  Future<void> sync({String account = 'acct-1', bool current = true}) =>
      push.sync(account: account, api: api, current: () => current);

  test('tells the backend once, and not again within the week', () async {
    await sync();
    expect(api.registered, [ios]);

    now = now.add(const Duration(days: 6));
    await sync();
    expect(api.registered, hasLength(1));

    now = now.add(const Duration(days: 2));
    await sync();
    expect(
      api.registered,
      hasLength(2),
      reason: 'renewed, so the backend keeps it',
    );
  });

  test('tells again when the token or the account changes', () async {
    await sync();
    channel.next = (token: 'apns-2', platform: 'ios');
    await sync();
    await sync(account: 'acct-2');
    expect(api.registered, [
      ios,
      (token: 'apns-2', platform: 'ios'),
      (token: 'apns-2', platform: 'ios'),
    ]);
  });

  test(
    'an Android token is registered and dropped with its platform',
    () async {
      channel.next = (token: 'fcm:1', platform: 'android');
      await sync();
      await sync();
      expect(api.registered, [(token: 'fcm:1', platform: 'android')]);
      await push.forget(api);
      expect(api.forgotten, [(token: 'fcm:1', platform: 'android')]);
    },
  );

  test('nothing while the OS cannot say whether notices are allowed', () async {
    allowed = null;
    await sync();
    expect(channel.asked, 0);
    expect(api.registered, isEmpty);
    expect(api.forgotten, isEmpty);
  });

  test('notices turned off: the backend lets go of the address it had for this account', () async {
    await sync();
    allowed = false;
    await sync();
    expect(api.forgotten, [ios]);
    expect(
      channel.asked,
      1,
      reason: 'no address is asked for while notices are off',
    );

    // Back on: told again at once, not a week later.
    allowed = true;
    await sync();
    expect(api.registered, hasLength(2));
  });

  test('notices off on a phone never told: nothing to take back', () async {
    allowed = false;
    await sync();
    expect(api.forgotten, isEmpty);
  });

  test(
    'no address (no push in this build, or the OS gave none): nothing is sent',
    () async {
      channel.next = null;
      await sync();
      expect(api.registered, isEmpty);
      expect(storage.values, isEmpty);
    },
  );

  test('a backend that did not take it is asked again after an hour, not at every resume', () async {
    api.refuseRegister = ApiException('Request failed (404)', status: 404);
    await sync();
    await sync();
    expect(api.attempts, 1);
    expect(storage.values, isEmpty, reason: 'not kept as told');

    api.refuseRegister = null;
    now = now.add(const Duration(minutes: 61));
    await sync();
    expect(api.registered, hasLength(1));
  });

  test('a sign-in that ended meanwhile registers nothing', () async {
    await sync(current: false);
    expect(api.registered, isEmpty);
    expect(storage.values, isEmpty);
  });

  test(
    'a sign-out takes the address back and stops the OS delivering to it',
    () async {
      await sync();
      await push.forget(api);
      expect(api.forgotten, [ios]);
      expect(channel.forgot, 1);
      expect(storage.values, isEmpty);

      // The next sign-in tells the backend again, whatever the week said.
      await sync();
      expect(api.registered, hasLength(2));
    },
  );

  test(
    'a sign-out the backend did not hear still stops the OS delivering',
    () async {
      await sync();
      api.refuseForget = ApiException('Request failed (503)', status: 503);
      await push.forget(api);
      expect(api.forgotten, isEmpty);
      expect(channel.forgot, 1);
      expect(
        storage.values,
        isEmpty,
        reason: 'the next account starts from nothing',
      );
    },
  );

  test(
    'a sync asked for before a sign-out registers nothing after it',
    () async {
      final answer = Completer<bool?>();
      push = PushTokens(
        channel: channel,
        storage: storage,
        allowed: () => answer.future,
        now: () => now,
      );
      final syncing = sync();
      final forgetting = push.forget(api);
      answer.complete(true);
      await Future.wait([syncing, forgetting]);
      expect(api.registered, isEmpty);
      expect(channel.forgot, 1);
    },
  );

  test('a record on disk it cannot read counts as never told', () async {
    await storage.write('push_token_sent_v1', '{not json');
    await sync();
    expect(api.registered, hasLength(1));
    final kept = jsonDecode(storage.values['push_token_sent_v1']!) as Map;
    expect(kept['account'], 'acct-1');
    expect(kept['token'], 'apns-1');
    expect(kept['platform'], 'ios');
  });

  test(
    'a record from before the platform was kept counts as never told',
    () async {
      await storage.write(
        'push_token_sent_v1',
        jsonEncode({
          'account': 'acct-1',
          'token': 'apns-1',
          'at': now.millisecondsSinceEpoch,
        }),
      );
      await sync();
      expect(api.registered, [ios]);
    },
  );
}

class _Channel extends PushChannel {
  PushAddress? next;
  int asked = 0;
  int forgot = 0;

  @override
  Future<PushAddress?> address() async {
    asked++;
    return next;
  }

  @override
  Future<void> forget() async => forgot++;
}

class _Api implements PushTokenApi {
  final registered = <PushAddress>[];
  final forgotten = <PushAddress>[];
  int attempts = 0;
  Object? refuseRegister;
  Object? refuseForget;

  @override
  Future<void> registerPushToken(PushAddress address) async {
    attempts++;
    if (refuseRegister case final error?) throw error;
    registered.add(address);
  }

  @override
  Future<void> forgetPushToken(PushAddress address) async {
    if (refuseForget case final error?) throw error;
    forgotten.add(address);
  }
}
