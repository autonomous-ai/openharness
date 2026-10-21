import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/dart.dart' show DartSha1;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/primitives.dart' show hmacSha256;
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/companions/coding_memory_connection.dart';
import 'package:harness/core/config.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/daemon_pipe_record.dart';
import 'package:harness/ws/local_daemon_transport.dart';
import 'package:harness/ws/trusted_pipe.dart';
import 'package:harness/ws/windows_pipe.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/ws/ws_pool.dart';

import 'support/pipe_daemon.dart';

const _port = 28473;
final _token = Uint8List.fromList(List.generate(32, (i) => 255 - i));

/// The trusted routes over the daemon's Windows pipe, with Unix sockets named
/// `harness-<id>` standing in for the pipe (the CLI's tests do the same) and
/// [dialStandIn] for kernel32. The real pipe is integration_test/windows_pipe_test.dart.
void main() {
  late Directory dir;
  final daemons = <PipeDaemon>[];

  setUp(() async {
    // Socket paths are capped near 104 bytes; the default temp dir is longer.
    dir = await Directory('/tmp').createTemp('hpipe-');
  });

  tearDown(() async {
    for (final daemon in daemons.reversed) {
      await daemon.close();
    }
    daemons.clear();
    await dir.delete(recursive: true);
  });

  Future<PipeDaemon> start(Future<PipeDaemon> daemon) async {
    final started = await daemon;
    daemons.add(started);
    return started;
  }

  TrustedPipe trustedPipe() => TrustedPipe(
    lookup: () =>
        readDaemonPipeRecord(dataDir: dir.path, port: _port, isWindows: false),
    dial: dialStandIn,
  );

  Future<void> until(bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  group(
    'TrustedPipe',
    () {
      TrustedPipe scripted(String Function(String request) answer) =>
          TrustedPipe(
            lookup: () => DaemonPipeRecord(
              pipePath: '/unused/harness-${'a' * 32}',
              pipeId: 'a' * 32,
              token: _token,
            ),
            dial: (_) async => _AnswerPipe(answer),
            timeout: const Duration(milliseconds: 300),
          );

      String proven(String request, String status, String rest) {
        final auth = RegExp(r'x-harness-auth: ([0-9a-f]{64})\.')
            .firstMatch(request)!;
        final proof = hmacSha256(_token, [0, ...utf8.encode(auth.group(1)!)]);
        final hex = proof
            .map((b) => b.toRadixString(16).padLeft(2, '0'))
            .join();
        return 'HTTP/1.1 $status\r\nx-harness-proof: $hex\r\n$rest';
      }

      test(
        'reads proven length and EOF bodies, including a proven refusal',
        () async {
          for (final framing in ['content-length: 4\r\n', '']) {
            final answer = await scripted(
              (request) => proven(request, '401 Refused', '$framing\r\nnope'),
            ).request('GET', '/api/status');
            expect(answer.status, 401);
            expect(utf8.decode(answer.body), 'nope');
          }
        },
      );

      test(
        'checks proof before interpreting an untrusted body length',
        () async {
          await expectLater(
            scripted(
              (_) => 'HTTP/1.1 401 Refused\r\ncontent-length: 99999999\r\n\r\n',
            ).request('GET', '/api/status'),
            throwsA(isA<PipeUnproven>()),
          );
        },
      );

      test('rejects an oversized chunk before waiting for its bytes', () async {
        await expectLater(
          scripted(
            (request) => proven(
              request,
              '200 OK',
              'transfer-encoding: chunked\r\n\r\n1000001\r\n',
            ),
          ).request('GET', '/api/status'),
          throwsA(
            isA<PipeProtocolError>().having(
              (e) => e.message,
              'message',
              contains('too large'),
            ),
          ),
        );
      });

      test(
        'reads a proven REST answer larger than the former 4 MiB limit',
        () async {
          final payload = 'x' * (4 * 1024 * 1024 + 1);
          final answer = await scripted(
            (request) => proven(
              request,
              '200 OK',
              'content-length: ${payload.length}\r\n\r\n$payload',
            ),
          ).request('GET', '/api/machines');
          expect(answer.body.length, payload.length);
        },
      );

      test('rejects a complete oversized status line', () async {
        await expectLater(
          scripted(
            (request) => proven(
              request,
              '200 ${'a' * 65536}',
              'content-length: 0\r\n\r\n',
            ),
          ).request('GET', '/api/status'),
          throwsA(isA<PipeProtocolError>()),
        );
      });

      test(
        'rejects negative body lengths and malformed chunk terminators',
        () async {
          for (final body in [
            'content-length: -1\r\n\r\n',
            'transfer-encoding: chunked\r\n\r\n-1\r\n',
            'transfer-encoding: chunked\r\n\r\n1\r\naXX0\r\n\r\n',
          ]) {
            await expectLater(
              scripted((request) => proven(request, '200 OK', body))
                  .request('GET', '/api/status'),
              throwsA(
                isA<PipeProtocolError>().having(
                  (e) => e.message,
                  'message',
                  contains('malformed'),
                ),
              ),
              reason: body,
            );
          }
        },
      );

      test(
        'rejects an upgrade with a valid proof but a wrong accept',
        () async {
          await expectLater(
            scripted(
              (request) => proven(
                request,
                '101 Switching Protocols',
                'upgrade: websocket\r\nsec-websocket-accept: wrong\r\n\r\n',
              ),
            ).webSocket('/api/local-ws'),
            throwsA(isA<PipeProtocolError>()),
          );
        },
      );

      test(
        'preserves the WebSocket frame read with the upgrade head',
        () async {
          final ws = await scripted((request) {
            expect(request.toLowerCase(), isNot(contains('origin:')));
            expect(
              request.toLowerCase(),
              isNot(contains('sec-websocket-extensions:')),
            );
            final key = RegExp(r'sec-websocket-key: ([^\r]+)')
                .firstMatch(request)!
                .group(1)!;
            final accept = base64.encode(
              const DartSha1()
                  .hashSync(
                    ascii.encode('${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11'),
                  )
                  .bytes,
            );
            return proven(
                  request,
                  '101 Switching Protocols',
                  'upgrade: websocket\r\nsec-websocket-accept: $accept\r\n\r\n',
                ) +
                String.fromCharCodes([0x81, 2, 104, 105]);
          }).webSocket('/api/local-ws');
          expect(await ws.first, 'hi');
          await ws.close();
        },
      );

      test('sends a fresh auth and takes the answer it proves', () async {
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        final pipe = trustedPipe();

        final answer = await pipe.request(
          'POST',
          '/api/auth/handoff',
          headers: {'content-type': 'application/json', 'x-adapter-local': '1'},
          body: '{}'.codeUnits,
        );
        expect(answer.status, 200);
        expect(String.fromCharCodes(answer.body), contains('hnh_pipe'));
        // A second request is a second nonce: the daemon takes each auth once.
        expect((await pipe.request('GET', '/api/status')).status, 200);
        expect(daemon.refused, isEmpty);
        expect(pipe.unavailable, isFalse);
      });

      test('a long-poll request can keep its own receive deadline', () async {
        final pipe = TrustedPipe(
          lookup: () => DaemonPipeRecord(
            pipePath: '/unused/harness-${'a' * 32}',
            pipeId: 'a' * 32,
            token: _token,
          ),
          dial: (_) async => _AnswerPipe(
            (request) =>
                proven(request, '200 OK', 'content-length: 2\r\n\r\nok'),
            delay: const Duration(milliseconds: 80),
          ),
          timeout: const Duration(milliseconds: 30),
        );
        final answer = await pipe.request(
          'POST',
          '/api/pair',
          timeout: const Duration(milliseconds: 200),
        );
        expect(utf8.decode(answer.body), 'ok');
      });

      test(
        'takes a body by length, chunked, or to the end of the connection',
        () async {
          // dart:io's server answers chunked unless told the length; the CLI's Node does both.
          final daemon = await start(PipeDaemon.pipe(dir, _token));
          writeDaemonRecord(dir, _port, daemon.path, _token);
          final answer = await trustedPipe().request('GET', '/api/status');
          expect(answer.headers['transfer-encoding'], ['chunked']);
          expect(String.fromCharCodes(answer.body), '{"pid":$pid}');
        },
      );

      test('a daemon restarted under a new pipe name is found on the next request, and the old name is never dialled again', () async {
        final before = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, before.path, _token);
        final pipe = trustedPipe();
        expect((await pipe.request('GET', '/api/status')).status, 200);

        // The restart: a new pipe, a new record. The old name still answers —
        // as whatever took it would — and must not be asked.
        final after = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, after.path, _token);
        expect((await pipe.request('GET', '/api/status')).status, 200);
        expect(before.hits, ['GET /api/status']);
        expect(after.hits, ['GET /api/status']);
      });

      test('a squatter on the recorded name, answering without the proof, is no pipe', () async {
        final squatter = await start(PipeDaemon.pipe(dir, _token, lies: true));
        writeDaemonRecord(dir, _port, squatter.path, _token);
        final pipe = trustedPipe();

        await expectLater(
          pipe.request('POST', '/api/auth/handoff'),
          throwsA(isA<PipeUnproven>()),
        );
        await expectLater(
          pipe.webSocket('/api/local-ws'),
          throwsA(isA<PipeUnproven>()),
        );
        expect(pipe.unavailable, isTrue);
        expect(await pipe.probe(), isFalse);

        // The daemon is back under a name of its own: trusted again at once.
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        expect(await pipe.probe(), isTrue);
        expect(pipe.unavailable, isFalse);
      });

      test(
        'a daemon that refuses the auth (another token) counts as no pipe',
        () async {
          final daemon = await start(PipeDaemon.pipe(dir, Uint8List(32)));
          writeDaemonRecord(dir, _port, daemon.path, _token);
          await expectLater(
            trustedPipe().request('GET', '/api/status'),
            throwsA(isA<PipeUnproven>()),
          );
          expect(daemon.refused, ['GET /api/status']);
        },
      );

      test('no record, or a pipe that is gone, is no pipe', () async {
        final pipe = trustedPipe();
        await expectLater(
          pipe.request('GET', '/api/status'),
          throwsA(isA<PipeRecordMissing>()),
        );
        expect(pipe.unavailable, isTrue);
        writeDaemonRecord(
          dir,
          _port,
          '${dir.path}/harness-${'0' * 32}',
          _token,
        );
        await expectLater(
          pipe.request('GET', '/api/status'),
          throwsA(isA<PipeAbsent>()),
        );
      });

      test('a pipe that never answers is given up in time, and its connection closed', () async {
        final path = '${dir.path}/harness-${'1' * 32}';
        final silent = await ServerSocket.bind(
          InternetAddress(path, type: InternetAddressType.unix),
          0,
        );
        addTearDown(silent.close);
        final closed = Completer<void>();
        silent.listen(
          (socket) => socket.listen((_) {}, onDone: closed.complete),
        );
        writeDaemonRecord(dir, _port, path, _token);
        final pipe = TrustedPipe(
          lookup: () => readDaemonPipeRecord(
            dataDir: dir.path,
            port: _port,
            isWindows: false,
          ),
          dial: dialStandIn,
          timeout: const Duration(milliseconds: 200),
        );

        await expectLater(
          pipe.request('GET', '/api/status'),
          throwsA(isA<PipeProtocolError>()),
        );
        expect(pipe.unavailable, isTrue);
        await closed.future.timeout(const Duration(seconds: 2));
      });

      test(
        'opens a WebSocket over the pipe once its 101 proves the daemon',
        () async {
          final daemon = await start(PipeDaemon.pipe(dir, _token));
          writeDaemonRecord(dir, _port, daemon.path, _token);
          final ws = await trustedPipe().webSocket('/api/local-ws');
          final replies = StreamIterator(ws);
          ws.add('{"type":"machine_select","payload":{"machineId":"m1"}}');
          expect(await replies.moveNext(), isTrue);
          expect(replies.current, contains('"connected"'));
          await ws.close();
          await replies.cancel();
          expect(daemon.selects, 1);
        },
      );
    },
    skip: Platform.isWindows
        ? 'Unix sockets stand in for the pipe off Windows; Windows runs the real one'
        : false,
  );

  group(
    'over LocalDaemonTransport',
    () {
      ApiClient api(PipeDaemon tcp, LocalDaemonTransport transport) =>
          ApiClient(
            config: AppConfig(
              apiBaseUrl: 'http://unused.invalid',
              localCliBaseUrl: 'http://127.0.0.1:${tcp.server.port}',
            ),
            session: AuthSession(),
            localTransport: transport,
          );

      WsConn connFor(PipeDaemon tcp, LocalDaemonTransport transport) => WsConn(
        wsBaseUrl: 'wss://unused.example',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse('ws://127.0.0.1:${tcp.server.port}/api/local-ws'),
        localTransport: transport,
        trustedLocal: true,
        fixedReconnectDelay: const Duration(milliseconds: 50),
      );

      Future<String> actRefusal(WsConn conn) async {
        try {
          await conn.request(
            'daemon_act',
            payload: {'id': 'say:1', 'choice': 'y'},
          );
          return 'answered';
        } on WsRequestFailure catch (failure) {
          return failure.code;
        }
      }

      test('every local REST call uses the proven pipe, without exposing the credential to TCP', () async {
        final tcp = await start(PipeDaemon.tcp());
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        final client = api(
          tcp,
          LocalDaemonTransport(
            trustedPipe: trustedPipe(),
            credential: () => 'secret',
          ),
        );

        expect((await client.phoneSignInCode())?.code, 'hnh_pipe');
        expect(client.phoneSignInUnavailable, isFalse);
        await client.me().catchError((_) => <String, dynamic>{});
        expect(daemon.hits, [
          'GET /api/status',
          'POST /api/auth/handoff',
          'GET /api/auth/me',
        ]);
        expect(tcp.hits, isEmpty);
      });

      test(
        'a missing pipe never sends REST or a local credential to stale TCP',
        () async {
          final tcp = await start(PipeDaemon.tcp());
          final client = api(
            tcp,
            LocalDaemonTransport(
              trustedPipe: trustedPipe(),
              credential: () => 'secret',
            ),
          );
          await expectLater(client.me(), throwsA(anything));
          expect(tcp.hits, isEmpty);
        },
      );

      test(
        'discovery does not probe a stale TCP port when the pipe is missing',
        () async {
          final tcp = await start(PipeDaemon.tcp());
          const computerId = '0123456789abcdef0123456789abcdef';
          final identity = File('${dir.path}/computer-id')
            ..writeAsStringSync(computerId);
          final discovery = LocalCliDiscovery(
            config: AppConfig(
              apiBaseUrl: 'https://harness-api.autonomous.ai',
              localCliBaseUrl: 'http://127.0.0.1:${tcp.server.port}',
            ),
            identity: LocalMachineIdentity(computerIdFile: identity),
            transport: LocalDaemonTransport(
              trustedPipe: trustedPipe(),
              recordedPort: () => tcp.server.port,
              credential: () => 'secret',
            ),
          );
          expect((await discovery.probe()).alive, isFalse);
          expect(tcp.hits, isEmpty);
        },
      );

      test('discovery accepts status from the proven pipe', () async {
        final tcp = await start(PipeDaemon.tcp());
        const computerId = '0123456789abcdef0123456789abcdef';
        final daemon = await start(
          PipeDaemon.pipe(
            dir,
            _token,
            status: {
              'computerId': computerId,
              'machineId': 'm1',
              'localWs': {
                'path': '/api/local-ws',
                'protocolVersion': 1,
                'terminalProtocolVersion': 3,
                'e2ee': false,
              },
            },
          ),
        );
        writeDaemonRecord(dir, _port, daemon.path, _token);
        final identity = File('${dir.path}/computer-id')
          ..writeAsStringSync(computerId);
        final discovery = LocalCliDiscovery(
          config: AppConfig(
            apiBaseUrl: 'https://harness-api.autonomous.ai',
            localCliBaseUrl: 'http://127.0.0.1:${tcp.server.port}',
          ),
          identity: LocalMachineIdentity(computerIdFile: identity),
          transport: LocalDaemonTransport(
            trustedPipe: trustedPipe(),
            recordedPort: () => tcp.server.port,
            credential: () => 'secret',
          ),
        );
        expect((await discovery.probe()).ready, isTrue);
        expect(daemon.hits, ['GET /api/status']);
        expect(tcp.hits, isEmpty);
      });

      test(
        'discovery abandons an accepted pipe that does not answer promptly',
        () async {
          final daemon = await start(
            PipeDaemon.pipe(dir, _token, hangStatus: true),
          );
          writeDaemonRecord(dir, _port, daemon.path, _token);
          const computerId = '0123456789abcdef0123456789abcdef';
          final identity = File('${dir.path}/computer-id')
            ..writeAsStringSync(computerId);
          final pipe = TrustedPipe(
            lookup: () => readDaemonPipeRecord(
              dataDir: dir.path,
              port: _port,
              isWindows: false,
            ),
            dial: dialStandIn,
            timeout: const Duration(seconds: 2),
          );
          final discovery = LocalCliDiscovery(
            config: const AppConfig(
              apiBaseUrl: 'https://harness-api.autonomous.ai',
              localCliBaseUrl: 'http://127.0.0.1:28473',
            ),
            identity: LocalMachineIdentity(computerIdFile: identity),
            transport: LocalDaemonTransport(trustedPipe: pipe),
          );
          final clock = Stopwatch()..start();
          expect((await discovery.probe()).alive, isFalse);
          expect(clock.elapsed, lessThan(const Duration(seconds: 1)));
          expect(daemon.hits, ['GET /api/status']);
        },
      );

      test('a lying pipe never receives a sign-in approval body', () async {
        final tcp = await start(PipeDaemon.tcp());
        final squatter = await start(PipeDaemon.pipe(dir, _token, lies: true));
        writeDaemonRecord(dir, _port, squatter.path, _token);
        final client = api(
          tcp,
          LocalDaemonTransport(trustedPipe: trustedPipe()),
        );
        await expectLater(
          client.approveSignIn('SENSITIVE_CODE'),
          throwsA(anything),
        );
        expect(squatter.hits, ['GET /api/status']);
        expect(squatter.bodies.join(), isNot(contains('SENSITIVE_CODE')));
        expect(tcp.hits, isEmpty);
      });

      test(
        'a proven pipe accepts a request body on the same connection',
        () async {
          final tcp = await start(PipeDaemon.tcp());
          final daemon = await start(PipeDaemon.pipe(dir, _token));
          writeDaemonRecord(dir, _port, daemon.path, _token);
          final client = api(
            tcp,
            LocalDaemonTransport(trustedPipe: trustedPipe()),
          );
          await expectLater(
            client.approveSignIn('TEST_CODE'),
            throwsA(anything),
          );
          expect(daemon.hits, ['GET /api/status', 'POST /api/auth/qr/approve']);
          expect(daemon.bodies.last, contains('TEST_CODE'));
          expect(tcp.hits, isEmpty);
        },
      );

      test('with no proven pipe the code is unavailable and never sent to the port', () async {
        final tcp = await start(PipeDaemon.tcp());
        final squatter = await start(PipeDaemon.pipe(dir, _token, lies: true));
        writeDaemonRecord(dir, _port, squatter.path, _token);
        final client = api(
          tcp,
          LocalDaemonTransport(trustedPipe: trustedPipe()),
        );

        expect(await client.phoneSignInCode(), isNull);
        expect(client.phoneSignInUnavailable, isTrue);
        expect(tcp.hits, isEmpty);
        // The next ask looks again, and finds the daemon's own pipe.
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        expect((await client.phoneSignInCode())?.code, 'hnh_pipe');
        expect(client.phoneSignInUnavailable, isFalse);
      });

      test(
        'off Windows nothing changes: no pipe, and nothing is unavailable',
        () {
          final transport = LocalDaemonTransport();
          expect(transport.trustedPipe, isNull);
          expect(transport.trustedRoutesUnavailable, isFalse);
          expect(
            LocalDaemonTransport.detect(Uri.parse('http://127.0.0.1:18473'))
                .trustedPipe,
            isNull,
          );
        },
      );

      test('this computer\'s window connection rides the pipe, where the daemon trusts it', () async {
        final tcp = await start(PipeDaemon.tcp());
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        final conn = connFor(
          tcp,
          LocalDaemonTransport(trustedPipe: trustedPipe()),
        );
        addTearDown(conn.close);
        await conn.connect();
        await until(() => conn.isReady);

        expect(daemon.selects, 1);
        expect(tcp.selects, 0);
        expect(conn.trustedPipeMissing, isFalse);
        expect(await actRefusal(conn), 'UNSUPPORTED');
      });

      test('a relayed machine\'s local connection uses the pipe', () async {
        final tcp = await start(PipeDaemon.tcp());
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        final conn = WsConn(
          wsBaseUrl: 'wss://unused.example',
          autonomousEnv: 'prod',
          machineId: 'm2',
          accessTokenProvider: (_, _) async => '',
          onAuthFailure: (_) {},
          onEvent: (_) {},
          onStatus: (_) {},
          transportKind: WsTransportKind.localPlaintext,
          localWsUri: Uri.parse(
            'ws://127.0.0.1:${tcp.server.port}/api/local-ws',
          ),
          localTransport: LocalDaemonTransport(trustedPipe: trustedPipe()),
        );
        addTearDown(conn.close);
        await conn.connect();
        await until(() => conn.isReady);
        expect(tcp.selects, 0);
        expect(daemon.selects, 1);
        expect(conn.trustedPipeMissing, isFalse);
      });

      test('owner memories use the injected proven pipe', () async {
        final tcp = await start(PipeDaemon.tcp());
        final daemon = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, daemon.path, _token);
        final connection = LocalCodingMemoryConnection(
          endpoint: LocalCliEndpoint(
            computerId: 'm1',
            wsUri: Uri(
              scheme: 'ws',
              host: '127.0.0.1',
              port: tcp.server.port,
              path: '/api/local-ws',
            ),
            socketPath: null,
            protocolVersion: 1,
            terminalProtocolVersion: 1,
          ),
          machineId: 'm1',
          localTransport: LocalDaemonTransport(trustedPipe: trustedPipe()),
          isCurrent: () => true,
          onClosed: () {},
        );
        addTearDown(connection.dispose);
        expect((await connection.request({'action': 'status'}))['ok'], isTrue);
        expect(daemon.selects, 1);
        expect(tcp.selects, 0);
      });

      test('a missing pipe never falls back to a stale port', () async {
        final tcp = await start(PipeDaemon.tcp());
        final transport = LocalDaemonTransport(trustedPipe: trustedPipe());
        final conn = connFor(tcp, transport);
        addTearDown(conn.close);
        await conn.connect();
        expect(conn.isReady, isFalse);
        expect(tcp.selects, 0);
        expect(conn.trustedPipeMissing, isTrue);
        expect(transport.trustedRoutesUnavailable, isTrue);
      });

      test(
        'a squatter cannot make the local connection ready or reach TCP',
        () async {
          final tcp = await start(PipeDaemon.tcp());
          final squatter = await start(
            PipeDaemon.pipe(dir, _token, lies: true),
          );
          writeDaemonRecord(dir, _port, squatter.path, _token);
          final conn = connFor(
            tcp,
            LocalDaemonTransport(trustedPipe: trustedPipe()),
          );
          addTearDown(conn.close);
          await conn.connect();
          expect(conn.isReady, isFalse);
          expect(conn.trustedPipeMissing, isTrue);
          expect(squatter.selects, 0);
          expect(tcp.selects, 0);
        },
      );

      test('the pool keeps the trusted connection apart: same flag, same socket; another flag, a new one', () async {
        final tcp = await start(PipeDaemon.tcp());
        final pool = WsPool(
          localTransport: LocalDaemonTransport(trustedPipe: trustedPipe()),
          wsBaseUrl: 'wss://unused.example',
          autonomousEnv: 'prod',
          accessTokenProvider: (_, _) async => '',
          onAuthFailure: (_) {},
          onEvent: (_, _) {},
          onStatus: (_, _) {},
        );
        addTearDown(pool.closeAll);
        final uri = Uri.parse('ws://127.0.0.1:${tcp.server.port}/api/local-ws');
        WsConn conn({required bool trusted}) => pool.connFor(
          'm1',
          transportKind: WsTransportKind.localPlaintext,
          localWsUri: uri,
          fixedReconnectDelay: const Duration(seconds: 1),
          trustedLocal: trusted,
        );
        final trusted = conn(trusted: true);
        expect(trusted.trustedLocal, isTrue);
        expect(identical(conn(trusted: true), trusted), isTrue);
        final plain = conn(trusted: false);
        expect(identical(plain, trusted), isFalse);
        expect(plain.trustedLocal, isFalse);
        expect(trusted.isClosed, isTrue);
      });

      test('a daemon restart moves the connection to the new pipe, never the old name', () async {
        final tcp = await start(PipeDaemon.tcp());
        final before = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, before.path, _token);
        final conn = connFor(
          tcp,
          LocalDaemonTransport(trustedPipe: trustedPipe()),
        );
        addTearDown(conn.close);
        await conn.connect();
        await until(() => conn.isReady);
        expect(before.selects, 1);

        final after = await start(PipeDaemon.pipe(dir, _token));
        writeDaemonRecord(dir, _port, after.path, _token);
        await before.close();
        await until(() => after.selects > 0 && conn.isReady);
        expect(after.selects, 1);
        expect(conn.trustedPipeMissing, isFalse);
        expect(before.hits, ['GET /api/local-ws']);
      });
    },
    skip: Platform.isWindows
        ? 'Unix sockets stand in for the pipe off Windows; Windows runs the real one'
        : false,
  );
}

/// A single raw HTTP answer, including malformed fixtures HttpServer cannot emit.
class _AnswerPipe implements PipeStream {
  _AnswerPipe(this.answer, {this.delay = Duration.zero});
  final String Function(String request) answer;
  final Duration delay;
  final _input = StreamController<Uint8List>();
  var _answered = false;
  @override
  Stream<Uint8List> get input => _input.stream;
  @override
  void add(List<int> bytes) {
    if (_answered) return;
    _answered = true;
    unawaited(
      Future<void>.delayed(delay, () async {
        if (_input.isClosed) return;
        _input.add(
          Uint8List.fromList(latin1.encode(answer(utf8.decode(bytes)))),
        );
        await _input.close();
      }),
    );
  }

  @override
  Future<void> close() async {
    if (!_input.isClosed) unawaited(_input.close());
  }
}
