import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/keys.dart';
import 'package:harness_mobile/e2ee/relay_session_crypto.dart';
import 'package:harness_mobile/e2ee/terminal_cipher.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/viewer/e2ee_relay_codec.dart';
import 'package:harness_mobile/ws/relay_codec.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../e2ee/machine_session.dart';
import 'fake_relay.dart';

/// A phone's relay connection end to end, against an in-memory relay with the machine behind it:
/// the dial, the E2EE handshake, requests and events through the session — and the ways each of
/// those goes wrong on a phone.
void main() {
  late E2eeIdentity phone;
  late E2eeIdentity machineIdentity;
  late FakeRelay relay;

  setUpAll(() async {
    phone = await E2eeIdentity.generate();
    machineIdentity = await E2eeIdentity.generate();
  });

  setUp(() async => relay = await FakeRelay.start(machineIdentity));
  tearDown(() async => relay.stop());

  RelayCodecFactory codecs() =>
      (machineId) async => E2eeRelayCodec(
        await RelaySessionCrypto.start(
          machineId: machineId,
          identity: phone,
          peerPub: machineIdentity.pub,
        ),
      );

  late List<ConnectionStatus> statuses;
  late List<String> signOuts;
  late List<(int, String)> localFailures;
  late List<Map<String, dynamic>> events;

  WsConn newConn({
    AccessTokenProvider? tokens,
    RelayCodecFactory? relayCodecs,
    bool noCodecs = false,
  }) {
    statuses = [];
    signOuts = [];
    localFailures = [];
    events = [];
    final conn = WsConn(
      wsBaseUrl: relay.url,
      connectChannel: relay.connect,
      autonomousEnv: 'test',
      machineId: machineId,
      accessTokenProvider: tokens ?? (_, _) async => 'token',
      onAuthFailure: signOuts.add,
      onLocalFailure: (code, reason) => localFailures.add((code, reason)),
      onEvent: events.add,
      onStatus: statuses.add,
      relayCodecs: noCodecs ? null : (relayCodecs ?? codecs()),
    );
    addTearDown(conn.close);
    return conn;
  }

  /// Polls rather than sleeping a fixed time.
  Future<bool> eventually(
    bool Function() check, {
    Duration within = const Duration(seconds: 3),
  }) async {
    final deadline = DateTime.now().add(within);
    while (DateTime.now().isBefore(deadline)) {
      if (check()) return true;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    return check();
  }

  /// A connection through its handshake, and the socket it rode in on.
  Future<(WsConn, RelayLink)> connected({AccessTokenProvider? tokens}) async {
    final conn = newConn(tokens: tokens);
    final session = relay.nextSession();
    unawaited(conn.connect());
    final link = await session.timeout(const Duration(seconds: 5));
    await conn.waitUntilReady(timeout: const Duration(seconds: 5));
    return (conn, link);
  }

  group('the handshake', () {
    test(
      'selects, says hello, and is ready once the pinned machine answers',
      () async {
        final (conn, link) = await connected();
        expect(conn.isReady, isTrue);
        expect(link.protocol, 'token');
        expect(link.frames.map((f) => f['type']), [
          'machine_select',
          'e2e_hello',
        ]);
        expect(statuses, [
          ConnectionStatus.connecting,
          ConnectionStatus.connected,
        ]);
        expect(conn.endpointKey, 'cloud:${relay.url}:test');
      },
    );

    test(
      'what was asked before it was ready goes once it is, sealed',
      () async {
        final conn = newConn();
        final session = relay.nextSession();
        final reply = conn.request('agents_list', payload: {'scope': 'all'});
        unawaited(conn.connect());
        final link = await session;
        await eventually(
          () => link.frames.any((f) => f['type'] == 'agents_list'),
        );
        final asked = link.frames.firstWhere((f) => f['type'] == 'agents_list');
        expect((asked['payload'] as Map).containsKey('__e2e'), isTrue);
        final opened = link.machine!.openDown(asked)!;
        expect(opened['scope'], 'all');
        link.send(
          link.machine!.target('agents_list_result', {
            'requestId': opened['requestId'],
            'agents': ['a'],
          }),
        );
        expect((await reply)['agents'], ['a']);
      },
    );

    test('a machine this phone never linked is never dialled', () async {
      final conn = newConn(relayCodecs: (_) async => null);
      await conn.connect();
      expect(relay.opened, 0);
      expect(localFailures, [(4404, 'NO_PEER_LINK')]);
      expect(conn.isClosed, isTrue);
      conn.reconnectNow();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(relay.opened, 0);
    });

    // A failed READ of the link is not the link being absent: a locked state file must stay
    // retryable, or one bad moment would read as "needs its password" for good.
    test('a link that could not be read is retried, not refused', () async {
      var reads = 0;
      final real = codecs();
      final conn = newConn(
        relayCodecs: (machineId) async {
          if (reads++ == 0) throw StateError('state.json is locked');
          return real(machineId);
        },
      );
      final session = relay.nextSession();
      await conn.connect();
      expect(localFailures, isEmpty);
      expect(conn.isClosed, isFalse);
      conn.reconnectNow();
      await session.timeout(const Duration(seconds: 3));
      await conn.waitUntilReady(timeout: const Duration(seconds: 3));
    });

    test('a machine that refuses this phone is not redialled', () async {
      relay.deny = true;
      final conn = newConn();
      await conn.connect();
      expect(await eventually(() => localFailures.isNotEmpty), isTrue);
      expect(localFailures.single, (4404, 'E2E_DENIED'));
      expect(conn.isClosed, isTrue);
      expect(statuses.last, ConnectionStatus.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      expect(relay.opened, 1);
    });

    test('a welcome from any other machine is refused for good', () async {
      final impostor = await E2eeIdentity.generate();
      relay.onHello = (link, hello) async =>
          (await MachineSession.answer(hello, identity: impostor)).welcome();
      final conn = newConn();
      await conn.connect();
      expect(await eventually(() => localFailures.isNotEmpty), isTrue);
      expect(localFailures.single, (4404, 'E2EE_WELCOME_INVALID'));
      expect(conn.isReady, isFalse);
    });

    // The relay can hand a welcome back at any time. Read as the machine failing to prove
    // itself, a repeat would close a working session for good and ask for the password again.
    test(
      'a second welcome on a live session is ignored, not refused',
      () async {
        final (conn, link) = await connected();
        link.send({
          'type': 'e2e_welcome',
          'payload': await link.machine!.welcome(),
        });
        link.send(link.machine!.target('ping_event', {'n': 1}));
        expect(await eventually(() => events.isNotEmpty), isTrue);
        expect(localFailures, isEmpty);
        expect(conn.isReady, isTrue);
        expect(
          statuses.where((s) => s == ConnectionStatus.connected),
          hasLength(1),
        );
      },
    );

    test(
      'a rekey from the machine moves the session to the new group key',
      () async {
        final (_, link) = await connected();
        final machine = link.machine!;
        link.send({
          'type': 'e2e_rekey',
          'payload': machine.rekey(
            Uint8List.fromList(List.filled(32, 5)),
            'e2',
          ),
        });
        link.send(machine.group('text_delta', {'text': 'after rekey'}));
        expect(await eventually(() => events.isNotEmpty), isTrue);
        expect(events.single['payload'], {'text': 'after rekey'});
      },
    );
  });

  group('frames from the machine', () {
    test('a sealed event opens once; a replay of it is dropped', () async {
      final (_, link) = await connected();
      final frame = link.machine!.target('agent_synced', {'id': 'a'});
      link.send(frame);
      link.send(frame);
      link.send(link.machine!.target('agent_synced', {'id': 'b'}));
      expect(await eventually(() => events.length >= 2), isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(events.map((e) => e['payload']['id']), ['a', 'b']);
    });

    test(
      'text that is not a JSON object is dropped, and the socket lives on',
      () async {
        final (conn, link) = await connected();
        link.sendText('not json');
        link.sendText('[1, 2, 3]');
        link.sendText('{"type": "x", "payload": "not an object"}');
        link.send({
          'type': 'node_status',
          'payload': {'online': true},
        });
        expect(await eventually(() => events.isNotEmpty), isTrue);
        expect(events.single['type'], 'node_status');
        expect(conn.isReady, isTrue);
      },
    );

    test(
      'a request the machine refuses fails with its code and detail',
      () async {
        final (conn, link) = await connected();
        final reply = conn.request('agent_create', payload: {'prompt': 'hi'});
        await eventually(
          () => link.frames.any((f) => f['type'] == 'agent_create'),
        );
        final asked = link.machine!.openDown(
          link.frames.firstWhere((f) => f['type'] == 'agent_create'),
        )!;
        expect(asked['prompt'], 'hi');
        link.send(
          link.machine!.target('agent_create_result', {
            'requestId': asked['requestId'],
            'error': 'SPAWN_FAILED',
            'detail': 'tmux: no server',
          }),
        );
        await expectLater(
          reply,
          throwsA(
            isA<WsRequestFailure>()
                .having((e) => e.code, 'code', 'SPAWN_FAILED')
                .having((e) => e.detail, 'detail', 'tmux: no server')
                .having(
                  (e) => '$e',
                  'text',
                  'agent_create_result: SPAWN_FAILED — tmux: no server',
                ),
          ),
        );
      },
    );

    test('a request nobody answers times out', () async {
      final (conn, _) = await connected();
      await expectLater(
        conn.request('agents_list', timeout: const Duration(milliseconds: 100)),
        throwsA(
          isA<WsRequestTimeout>().having(
            (e) => '$e',
            'text',
            contains('agents_list'),
          ),
        ),
      );
    });

    test(
      'terminal bytes come up opened, and a forged frame is dropped',
      () async {
        final conn = newConn();
        final got = <Uint8List>[];
        conn.onBinaryFrame = (frame) async => got.add(frame);
        final session = relay.nextSession();
        unawaited(conn.connect());
        final link = await session;
        await conn.waitUntilReady(timeout: const Duration(seconds: 3));
        link.sendBytes(Uint8List(40));
        link.sendBytes(link.machine!.terminal('hello'));
        expect(await eventually(() => got.isNotEmpty), isTrue);
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(got, hasLength(1));
        expect(utf8.decode(decodeTerminalLocal(got.single)!.bytes), 'hello');
      },
    );
  });

  group('frames to the machine', () {
    TerminalBinaryFrame input(String text) => TerminalBinaryFrame(
      kind: TerminalBinaryKind.input,
      streamId: streamId,
      seq: 1,
      bytes: utf8Bytes(text),
      compressed: false,
    );

    test(
      'terminal input is refused before the session, sealed after',
      () async {
        final conn = newConn();
        expect(
          await conn.sendTerminalFrame('terminal_input', {'data': 'x'}),
          isFalse,
        );
        expect(
          await conn.sendTerminalBinary(encodeTerminalLocal(input('x'))!),
          isFalse,
        );

        final session = relay.nextSession();
        unawaited(conn.connect());
        final link = await session;
        await conn.waitUntilReady(timeout: const Duration(seconds: 3));
        expect(
          await conn.sendTerminalFrame('terminal_input', {
            'streamId': streamId,
            'data': 'ls',
          }),
          isTrue,
        );
        expect(
          await conn.sendTerminalBinary(encodeTerminalLocal(input('pwd'))!),
          isTrue,
        );
        expect(
          await conn.sendTerminalBinary(Uint8List.fromList([1, 2, 3])),
          isFalse,
        );
        await eventually(() => link.binary.isNotEmpty);
        expect(link.opened('terminal_input').single['data'], 'ls');
        final sealed = openTerminalBinary(
          link.machine!.terminalC2s,
          link.binary.single,
        )!;
        expect(utf8.decode(sealed.frame.bytes), 'pwd');
      },
    );

    test('sendRaw goes out as it is when its type is not sealed', () async {
      final (conn, link) = await connected();
      conn.sendRaw('app_presence', {'focused': true});
      await eventually(
        () => link.frames.any((f) => f['type'] == 'app_presence'),
      );
      expect(link.opened('app_presence').single, {'focused': true});
    });
  });

  test('what a failure prints is its sentence', () {
    expect('${const WsCredentialRevoked('Sign in again.')}', 'Sign in again.');
    expect(
      '${const WsRequestFailure(responseType: 'agent_delete_result', code: 'AGENT_BUSY')}',
      'agent_delete_result: AGENT_BUSY',
    );
    expect(
      '${const WsRequestFailure(responseType: 'x', code: 'C', detail: '')}',
      'x: C',
    );
  });

  group('the session ending', () {
    test('the socket dropping rejects what was pending and redials', () async {
      final (conn, link) = await connected();
      final pending = conn.request('agents_list');
      await eventually(
        () => link.frames.any((f) => f['type'] == 'agents_list'),
      );
      final next = relay.nextSession();
      await link.close();
      await expectLater(pending, throwsA(isA<Exception>()));
      expect(
        await eventually(
          () => statuses.contains(ConnectionStatus.reconnecting),
        ),
        isTrue,
      );
      // The dial after a drop is a fresh session: a new hello, answered again.
      conn.reconnectNow();
      final second = await next.timeout(const Duration(seconds: 3));
      await conn.waitUntilReady(timeout: const Duration(seconds: 3));
      expect(second, isNot(same(link)));
      expect(second.machine!.webEphPub, isNot(link.machine!.webEphPub));
    });

    test('forcing a reconnect is a fresh dial and a fresh session', () async {
      final (conn, link) = await connected();
      final pending = conn.request('agents_list');
      final next = relay.nextSession();
      await conn.forceReconnect();
      await expectLater(pending, throwsA(isA<Exception>()));
      final second = await next.timeout(const Duration(seconds: 3));
      expect(second.machine!.webEphPub, isNot(link.machine!.webEphPub));
      await conn.waitUntilReady(timeout: const Duration(seconds: 3));
    });

    test(
      'a closed connection refuses readiness waits and stays closed',
      () async {
        final (conn, _) = await connected();
        await conn.close();
        expect(conn.isClosed, isTrue);
        await expectLater(
          conn.waitUntilReady(timeout: const Duration(seconds: 1)),
          throwsStateError,
        );
        await conn.forceReconnect();
        expect(relay.opened, 1);
      },
    );

    test(
      'a readiness wait that runs out says the select went unanswered',
      () async {
        relay.silentOnSelect = true;
        final conn = newConn();
        unawaited(conn.connect());
        await expectLater(
          conn.waitUntilReady(timeout: const Duration(milliseconds: 200)),
          throwsA(isA<WsRequestTimeout>()),
        );
      },
    );

    test('a relay that never answers the select is redialled', () async {
      relay.silentOnSelect = true;
      final conn = newConn();
      await conn.connect();
      expect(relay.opened, 1);
      // Six seconds of silence, then the watchdog's redial — through the backoff, a second on.
      expect(
        await eventually(
          () => relay.opened >= 2,
          within: const Duration(seconds: 9),
        ),
        isTrue,
      );
      expect(conn.isReady, isFalse);
    }, timeout: const Timeout(Duration(seconds: 20)));

    test('a relay whose environment does not match signs out', () async {
      relay.closeOnSelect = 4403;
      final conn = newConn();
      await conn.connect();
      expect(await eventually(() => signOuts.isNotEmpty), isTrue);
      expect(signOuts.single, contains('environment'));
      expect(conn.isClosed, isTrue);
    });

    test('a refused dial is retried with backoff', () async {
      relay.refuse = true;
      final conn = newConn();
      await conn.connect();
      expect(statuses.last, ConnectionStatus.reconnecting);
      expect(conn.isReady, isFalse);
      expect(signOuts, isEmpty);
    });

    test('a missing credential is a failed dial, not a sign-out', () async {
      final conn = newConn(tokens: (_, _) async => '');
      await conn.connect();
      expect(relay.opened, 0);
      expect(signOuts, isEmpty);
      expect(statuses.last, ConnectionStatus.reconnecting);
    });

    test('a debug drop takes the real reconnect path', () async {
      final (conn, _) = await connected();
      await conn.debugDropTransport();
      expect(
        await eventually(
          () => statuses.contains(ConnectionStatus.reconnecting),
        ),
        isTrue,
      );
      expect(conn.isClosed, isFalse);
      await expectLater(newConn().debugDropTransport(), throwsStateError);
    });
  });

  group('the session being gone for good', () {
    test('a refused refresh on 4401 signs out', () async {
      relay.closeOnSelect = 4401;
      final conn = newConn(
        tokens: (force, _) async =>
            force ? throw const WsCredentialRevoked('revoked') : 'token',
      );
      await conn.connect();
      expect(await eventually(() => signOuts.isNotEmpty), isTrue);
      expect(conn.isClosed, isTrue);
    });

    // ⚠️ Signing out closes every connection, and one still waiting on its credential then learns
    // the session is gone. That is the sign-out it is already part of, not news: reported, it
    // re-entered the app's sign-out halfway through the one in progress, which then stopped
    // early — and left the previous account's machines in the warm-start cache.
    test('a connection closed while fetching its credential does not sign out again', () async {
      final credential = Completer<String>();
      final conn = newConn(tokens: (_, _) => credential.future);
      final dialling = conn.connect();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await conn.close();
      credential.completeError(const WsCredentialRevoked('Not signed in.'));
      await dialling;
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(signOuts, isEmpty);
      expect(relay.opened, 0);
    });

    test('nor does one closed while refreshing after a 4401', () async {
      relay.closeOnSelect = 4401;
      final refresh = Completer<String>();
      final conn = newConn(
        tokens: (force, _) => force ? refresh.future : Future.value('token'),
      );
      await conn.connect();
      expect(
        await eventually(
          () => statuses.contains(ConnectionStatus.reconnecting),
        ),
        isTrue,
      );
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await conn.close();
      refresh.completeError(const WsCredentialRevoked('revoked'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(signOuts, isEmpty);
    });

    // ⚠️ A relay that refuses every token with 4401 — the backend and the account API disagreeing
    // about a session, say — used to be asked again the moment each refresh landed: no backoff at
    // all, a refresh and a dial per round trip, for as long as the app stayed open.
    test('a relay that keeps refusing the token is not hammered', () async {
      relay.closeOnSelect = 4401;
      var refreshes = 0;
      final conn = newConn(
        tokens: (force, _) async {
          if (force) refreshes++;
          return 'token-$refreshes';
        },
      );
      await conn.connect();
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      expect(
        relay.opened,
        lessThanOrEqualTo(3),
        reason: 'the first refusal is retried at once; after that, the backoff applies',
      );
      expect(refreshes, lessThanOrEqualTo(3));
      expect(signOuts, isEmpty);
    });

    test(
      'an expired token mid-session is renewed and redialled at once',
      () async {
        String? failed;
        var forced = 0;
        final (conn, link) = await connected(
          tokens: (force, failedToken) async {
            if (force) {
              forced++;
              failed = failedToken;
              return 'renewed';
            }
            return forced == 0 ? 'token' : 'renewed';
          },
        );
        final next = relay.nextLink();
        await link.close(4401, 'auth expired');
        // Inside the first backoff step (a second): the redial can only be the immediate one.
        final second = await next.timeout(const Duration(milliseconds: 900));
        expect(failed, 'token');
        expect(second.protocol, 'renewed');
        await conn.waitUntilReady(timeout: const Duration(seconds: 3));
      },
    );
  });
}
