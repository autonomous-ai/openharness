import 'dart:convert';
import 'dart:io' show ZLibEncoder;
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/terminal/terminal_viewport.dart';

/// The terminal stream protocol a phone speaks with a machine's daemon, frame
/// by frame: an open and its answer, a screen and the output after it, gaps
/// and the resync that repairs them, a stream closed or taken, and everything
/// typed, pasted and uploaded back.
void main() {
  late _Wire wire;

  setUp(() => wire = _Wire());

  /// [disposeAtEnd] false for a test that disposes the session itself.
  TerminalSession session({
    String engine = 'claude',
    bool takeover = true,
    Future<bool> Function()? onOpenStalled,
    Duration resync = const Duration(milliseconds: 40),
    bool disposeAtEnd = true,
  }) {
    final built = TerminalSession(
      machineId: 'm',
      agentId: 'a',
      agentName: 'a',
      engineId: engine,
      send: wire.send,
      sendBinary: wire.sendBinary,
      client: const TerminalClientDescriptor(kind: 'phone', name: 'Pat'),
      onOpenStalled: onOpenStalled,
      resyncTimeout: resync,
      takeover: takeover,
    );
    if (disposeAtEnd) addTearDown(built.dispose);
    return built;
  }

  /// Real time passing until [done], in small steps — for a ladder of timers
  /// whose exact rungs a test wants to stop between.
  Future<void> until(bool Function() done) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 2));
    }
    expect(done(), isTrue, reason: 'never got there');
  }

  /// The daemon answering the last open: a stream id.
  Future<String> ready(
    TerminalSession s, {
    bool readOnly = false,
    Map<String, dynamic>? heldBy,
  }) async {
    final streamId = _streamId();
    await s.handleFrame('terminal_ready', {
      'requestId': wire.last('terminal_open')['requestId'],
      'agentId': 'a',
      'protocolVersion': TerminalSession.protocolVersion,
      'streamId': streamId,
      if (readOnly) 'readOnly': true,
      'heldBy': ?heldBy,
    });
    return streamId;
  }

  /// A session with a stream and its first screen.
  Future<(TerminalSession, String)> live({
    String engine = 'claude',
    String screen = 'prompt> ',
    Duration resync = const Duration(milliseconds: 40),
  }) async {
    final s = session(engine: engine, resync: resync);
    await s.open();
    final streamId = await ready(s);
    await s.handleBinary(_keyframe(streamId, text: screen));
    return (s, streamId);
  }

  group('the open', () {
    test(
      'asks for the agent at a size the daemon will accept, and says who asks',
      () async {
        final s = session();

        await s.open(initialCols: 10, initialRows: 500);

        final open = wire.last('terminal_open');
        expect(open['protocolVersion'], TerminalSession.protocolVersion);
        expect(open['agentId'], 'a');
        expect(open['cols'], TerminalSession.minCols);
        expect(open['rows'], TerminalSession.maxRows);
        expect(open['compression'], ['zlib', 'none']);
        expect(open['client'], {'kind': 'phone', 'name': 'Pat'});
        expect(open.containsKey('takeover'), isFalse);
        expect(s.status, TerminalSessionStatus.opening);
        expect(s.holdsTerminal, isTrue);
        expect(s.hasRenderedFrame, isFalse);
      },
    );

    test('a polite open says so', () async {
      final s = session(takeover: false);

      await s.open();

      expect(wire.last('terminal_open')['takeover'], isFalse);
    });

    test('waits for the panel\'s own measurement', () async {
      final s = session();

      final opening = s.open(waitForViewportSize: true);
      await Future<void>.delayed(Duration.zero);
      expect(wire.of('terminal_open'), isEmpty);
      s.reportViewport(120, 40);
      s.reportViewport(10, 10);
      await opening;

      expect(wire.last('terminal_open')['cols'], 120);
      expect(wire.last('terminal_open')['rows'], 40);
    });

    test('opens at the fallback size when the panel never measures', () {
      fakeAsync((async) {
        final s = session(disposeAtEnd: false);
        s.open(waitForViewportSize: true);
        async.elapse(const Duration(seconds: 3));

        expect(wire.last('terminal_open')['cols'], 80);
        expect(wire.last('terminal_open')['rows'], 24);
        s.dispose();
      });
    });

    test(
      'an open that cannot be sent, with nothing to recover it, fails',
      () async {
        wire.sends = false;
        final s = session();

        await s.open();

        expect(s.status, TerminalSessionStatus.error);
        expect(s.errorMessage, 'Could not send terminal_open');
      },
    );

    test(
      'an open that cannot be sent redials once and sends it again',
      () async {
        var redials = 0;
        final s = session(
          onOpenStalled: () async {
            redials++;
            wire.sends = true;
            return true;
          },
        );
        wire.sends = false;

        await s.open();

        expect(redials, 1);
        expect(s.status, TerminalSessionStatus.opening);
        expect(wire.of('terminal_open'), hasLength(2));
        expect(
          wire.of('terminal_open').last['requestId'],
          wire.of('terminal_open').first['requestId'],
        );
      },
    );

    test('a redial that throws still started one, and is polled', () async {
      final s = session(
        onOpenStalled: () async {
          wire.sends = true;
          throw StateError('socket closed mid-redial');
        },
      );
      wire.sends = false;

      await s.open();

      expect(s.status, TerminalSessionStatus.opening);
    });

    test(
      'a transport that declines the redial keeps its one recovery',
      () async {
        var asked = 0;
        final s = session(
          onOpenStalled: () async {
            asked++;
            return false;
          },
        );
        wire.sends = false;

        await s.open();
        expect(s.status, TerminalSessionStatus.error);

        // Declined, so not spent: the next open that stalls may still redial.
        await s.reopen();
        expect(asked, 2);
      },
    );

    // On the fake clock, like the test below: on the real one a 20ms resync and a 120ms wait
    // raced a loaded machine, and the resend landed after the check in one full run of several.
    test('silence after the open redials, resends, then gives up', () {
      fakeAsync((async) {
        var redials = 0;
        final s = session(
          disposeAtEnd: false,
          onOpenStalled: () async {
            redials++;
            return true;
          },
          resync: const Duration(milliseconds: 20),
        );

        s.open();
        async.flushMicrotasks();
        async.elapse(const Duration(milliseconds: 120));

        expect(redials, 1, reason: 'one forced redial per open');
        expect(wire.of('terminal_open').length, greaterThanOrEqualTo(2));
        expect(s.status, TerminalSessionStatus.error);
        expect(s.errorCode, 'TERMINAL_RESYNC_TIMEOUT');
        expect(s.errorMessage, contains('did not respond'));
        s.dispose();
      });
    });

    test('a resend that cannot be sent either gives up at once', () {
      fakeAsync((async) {
        final s = session(
          disposeAtEnd: false,
          onOpenStalled: () async {
            wire.sends = false;
            return true;
          },
        );
        s.open();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 5));

        expect(s.status, TerminalSessionStatus.error);
        expect(s.errorCode, 'TERMINAL_RESYNC_TIMEOUT');
        s.dispose();
      });
    });
  });

  group('terminal_ready', () {
    test(
      'an answer to another open, agent or protocol is not this one\'s',
      () async {
        final s = session();
        await s.open();
        final requestId = wire.last('terminal_open')['requestId'];

        for (final payload in [
          {'requestId': 'other', 'agentId': 'a', 'protocolVersion': 3},
          {'requestId': requestId, 'agentId': 'b', 'protocolVersion': 3},
          {'requestId': requestId, 'agentId': 'a', 'protocolVersion': 2},
        ]) {
          expect(
            await s.handleFrame('terminal_ready', {
              ...payload,
              'streamId': _streamId(),
            }),
            isTrue,
          );
        }

        expect(s.streamId, isNull);
        expect(s.status, TerminalSessionStatus.opening);
      },
    );

    test('a ready with no stream is a failure', () async {
      final s = session();
      await s.open();

      await s.handleFrame('terminal_ready', {
        'requestId': wire.last('terminal_open')['requestId'],
        'agentId': 'a',
        'protocolVersion': TerminalSession.protocolVersion,
      });

      expect(s.status, TerminalSessionStatus.error);
      expect(s.errorCode, 'TERMINAL_READY_INVALID');
    });

    test('an answered takeover is spent', () async {
      final s = session();
      await s.open();
      expect(s.takeover, isTrue);

      await ready(s);

      expect(s.takeover, isFalse);
    });

    test(
      'a read-only answer watches, names the holder and types nothing',
      () async {
        final s = session();
        await s.open();

        final streamId = await ready(
          s,
          readOnly: true,
          heldBy: {'kind': 'desktop', 'name': 'Studio'},
        );
        await s.handleBinary(_keyframe(streamId));
        s.terminal.textInput('x');
        await Future<void>.delayed(Duration.zero);

        expect(s.watching, isTrue);
        expect(s.heldBy?.name, 'Studio');
        expect(
          s.takeover,
          isTrue,
          reason: 'nothing was won, so nothing is spent',
        );
        expect(s.acceptsInput, isFalse);
        expect(wire.binaries, isEmpty);
      },
    );

    test(
      'a second answer to the same open leaves one heartbeat, and none after',
      () {
        fakeAsync((async) {
          final s = session(disposeAtEnd: false);
          s.open();
          async.flushMicrotasks();
          final requestId = wire.last('terminal_open')['requestId'];
          Map<String, dynamic> answer(String streamId) => {
            'requestId': requestId,
            'agentId': 'a',
            'protocolVersion': TerminalSession.protocolVersion,
            'streamId': streamId,
          };
          // The original reply, late, and the reply to the SAME open resent
          // after the watchdog gave up on it — both match, and both land before
          // the first screen.
          s.handleFrame('terminal_ready', answer(_streamId()));
          final second = _streamId();
          s.handleFrame('terminal_ready', answer(second));
          s.handleBinary(_keyframe(second));
          async.flushMicrotasks();

          async.elapse(const Duration(seconds: 5));
          expect(wire.of('terminal_alive'), hasLength(1));

          s.dispose();
          async.elapse(const Duration(seconds: 20));
          expect(
            wire.of('terminal_alive'),
            hasLength(1),
            reason: 'a disposed session sends nothing',
          );
        });
      },
    );

    test(
      'heartbeats keep a live stream alive, and a failed one is a lost stream',
      () {
        fakeAsync((async) {
          final s = session(disposeAtEnd: false);
          s.open();
          async.flushMicrotasks();
          s.handleFrame('terminal_ready', {
            'requestId': wire.last('terminal_open')['requestId'],
            'agentId': 'a',
            'protocolVersion': TerminalSession.protocolVersion,
            'streamId': _streamId(),
          });
          s.handleBinary(_keyframe(s.streamId!));
          async.flushMicrotasks();

          async.elapse(const Duration(seconds: 10));
          expect(wire.of('terminal_alive'), hasLength(2));

          wire.sends = false;
          async.elapse(const Duration(seconds: 5));
          expect(s.status, TerminalSessionStatus.error);
          expect(s.errorMessage, 'Terminal heartbeat was not sent');
          s.dispose();
        });
      },
    );
  });

  group('the screen and the output after it', () {
    test('a keyframe before its stream is ready is dropped, and the watchdog asks again', () async {
      final s = session();
      await s.open();
      final streamId = _streamId();

      // The screen overtakes its own ready.
      await s.handleBinary(_keyframe(streamId));
      expect(s.hasRenderedFrame, isFalse);

      await s.handleFrame('terminal_ready', {
        'requestId': wire.last('terminal_open')['requestId'],
        'agentId': 'a',
        'protocolVersion': TerminalSession.protocolVersion,
        'streamId': streamId,
      });
      await Future<void>.delayed(const Duration(milliseconds: 60));

      expect(s.status, TerminalSessionStatus.resyncing);
      expect(wire.last('terminal_resync'), {
        'streamId': streamId,
        'attempt': 1,
        'reason': 'TERMINAL_KEYFRAME_TIMEOUT',
      });

      await s.handleBinary(_keyframe(streamId, seq: 5));
      expect(s.status, TerminalSessionStatus.controlling);
      expect(s.hasRenderedFrame, isTrue);
    });

    test('a frame for another stream is not drawn', () async {
      final (s, _) = await live();
      final ticks = s.outputTicks.value;

      await s.handleBinary(_output(_streamId(), 1, 'stray'));

      expect(s.outputTicks.value, ticks);
      expect(s.status, TerminalSessionStatus.controlling);
    });

    test('output in order is drawn and acknowledged', () async {
      final (s, streamId) = await live();

      await s.handleBinary(_output(streamId, 1, 'hello '));
      await s.handleBinary(_output(streamId, 2, 'world'));
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(_screen(s), contains('hello world'));
      expect(wire.last('terminal_ack'), {'streamId': streamId, 'lastSeq': 2});
    });

    test('a scalar split across two frames is drawn whole', () async {
      final (s, streamId) = await live(screen: '');
      final bytes = utf8.encode('é');

      await s.handleBinary(
        _output(streamId, 1, null, bytes: bytes.sublist(0, 1)),
      );
      await s.handleBinary(_output(streamId, 2, null, bytes: bytes.sublist(1)));

      expect(_screen(s), contains('é'));
    });

    test(
      'a gap is repaired by a resync, and output meanwhile is dropped',
      () async {
        final (s, streamId) = await live(resync: const Duration(seconds: 5));

        await s.handleBinary(_output(streamId, 3, 'skipped ahead'));
        expect(s.status, TerminalSessionStatus.resyncing);
        expect(s.errorCode, 'TERMINAL_SEQUENCE_GAP');
        expect(wire.last('terminal_resync')['attempt'], 1);
        expect(s.acceptsInput, isFalse);

        await s.handleBinary(_output(streamId, 4, 'more'));
        await s.handleBinary(_sync(streamId, 5));
        expect(_screen(s), isNot(contains('more')));

        await s.handleBinary(_keyframe(streamId, seq: 9, text: 'repaired'));
        expect(s.status, TerminalSessionStatus.controlling);
        expect(s.errorCode, isNull);
        expect(_screen(s), contains('repaired'));

        await s.handleBinary(_output(streamId, 10, ' next'));
        expect(_screen(s), contains('repaired next'));
      },
    );

    test(
      'a sync frame moves the sequence on; one out of order is a gap',
      () async {
        final (s, streamId) = await live(resync: const Duration(seconds: 5));

        await s.handleBinary(_sync(streamId, 1));
        await s.handleBinary(_output(streamId, 2, 'after sync'));
        expect(_screen(s), contains('after sync'));

        await s.handleBinary(_sync(streamId, 9));
        expect(s.status, TerminalSessionStatus.resyncing);
      },
    );

    test('a sync or output before any screen asks for one', () async {
      for (final frame in [
        _sync,
        (String id, int seq) => _output(id, seq, 'x'),
      ]) {
        final s = session(resync: const Duration(seconds: 5));
        await s.open();
        final streamId = await ready(s);

        await s.handleBinary(frame(streamId, 0));

        expect(s.status, TerminalSessionStatus.resyncing);
      }
    });

    test(
      'three unanswered resyncs, then one reopen, then it says so',
      () async {
        final (s, streamId) = await live(
          resync: const Duration(milliseconds: 20),
        );

        await s.handleBinary(_output(streamId, 7, 'gap'));
        await until(() => wire.of('terminal_open').length == 2);

        expect(
          [for (final r in wire.of('terminal_resync')) r['attempt']],
          [1, 2, 3],
        );
        expect(wire.last('terminal_close'), {'streamId': streamId});
        expect(s.status, TerminalSessionStatus.opening);
        expect(
          _screen(s),
          contains('prompt>'),
          reason: 'kept through the reopen',
        );

        // The reopened stream answers, and never draws.
        await ready(s);
        await until(() => s.status == TerminalSessionStatus.error);

        expect(
          s.errorMessage,
          'Terminal did not recover after resync and reopen.',
        );
      },
    );

    test('a reopen nobody answers says the reopen failed', () async {
      final (s, streamId) = await live(
        resync: const Duration(milliseconds: 20),
      );

      await s.handleBinary(_output(streamId, 7, 'gap'));
      await until(() => wire.of('terminal_open').length == 2);
      await until(() => s.status == TerminalSessionStatus.error);

      expect(s.errorCode, 'TERMINAL_RESYNC_TIMEOUT');
      expect(s.errorMessage, 'Terminal did not reopen after resync failed.');
    });

    test('a screen after the reopen resets the ladder', () async {
      final (s, streamId) = await live(
        resync: const Duration(milliseconds: 20),
      );
      await s.handleBinary(_output(streamId, 7, 'gap'));
      await until(() => wire.of('terminal_open').length == 2);

      final second = await ready(s);
      await s.handleBinary(_keyframe(second));
      await s.handleBinary(_output(second, 1, 'fine'));
      expect(s.status, TerminalSessionStatus.controlling);
      expect(_screen(s), contains('fine'));

      // A second gap climbs the whole ladder again, reopen included.
      await s.handleBinary(_output(second, 9, 'gap'));
      await until(() => wire.of('terminal_open').length == 3);
      expect(s.status, TerminalSessionStatus.opening);
    });

    test('a resync that cannot be sent is a lost stream', () async {
      final (s, streamId) = await live();
      wire.sends = false;

      await s.handleBinary(_output(streamId, 5, 'gap'));

      expect(s.status, TerminalSessionStatus.error);
      expect(s.errorMessage, 'Could not request terminal resync');
    });

    test(
      'a compressed screen is inflated; a corrupt one is asked for again',
      () async {
        final s = session(resync: const Duration(seconds: 5));
        await s.open();
        final streamId = await ready(s);

        await s.handleBinary(
          _keyframe(
            streamId,
            bytes: ZLibEncoder().convert(utf8.encode('zipped')),
            compressed: true,
          ),
        );
        expect(_screen(s), contains('zipped'));

        await s.handleBinary(
          _output(streamId, 1, null, bytes: [1, 2, 3], compressed: true),
        );
        expect(s.status, TerminalSessionStatus.resyncing);
        expect(s.errorCode, 'TERMINAL_BINARY_DECODE_FAILED');
      },
    );

    test('a screen with no size is asked for again', () async {
      final s = session(resync: const Duration(seconds: 5));
      await s.open();
      final streamId = await ready(s);

      await s.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: streamId,
          seq: 0,
          bytes: Uint8List(0),
          compressed: false,
        ),
      );

      expect(s.errorCode, 'TERMINAL_KEYFRAME_INVALID');
    });

    test(
      'a renderer that throws is repaired by a resync, not a dead tile',
      () async {
        final (s, _) = await live(resync: const Duration(seconds: 5));

        await s.onRendererFailure();

        expect(s.status, TerminalSessionStatus.resyncing);
        expect(s.errorCode, 'TERMINAL_RENDERER_FAILED');
      },
    );

    test('a resync with no stream to ask on is a failure', () async {
      final s = session();

      await s.onRendererFailure();

      expect(s.status, TerminalSessionStatus.error);
    });

    test('Grok is drawn in the alternate buffer, reset or not', () async {
      for (final screen in ['\x1bcgrok', 'grok']) {
        final (s, _) = await live(engine: 'grok', screen: screen);

        expect(s.terminal.isUsingAltBuffer, isTrue);
        expect(s.scrollViaTmuxCopyMode, isTrue);
      }
    });

    test('bulk data sent as JSON is refused', () async {
      final (s, _) = await live();

      expect(await s.handleFrame('terminal_output', {}), isTrue);

      expect(s.status, TerminalSessionStatus.error);
      expect(s.errorCode, 'TERMINAL_BINARY_REQUIRED');
    });

    test('a kept screen stands in until the first real one', () async {
      final (first, _) = await live(screen: 'last time');
      final s = session();

      s.seedScreen(first.terminal);
      expect(s.showingKeptScreen, isTrue);
      expect(s.hasScreen, isTrue);
      final opening = s.open(waitForViewportSize: true);
      expect(_screen(s), contains('last time'), reason: 'through the open');
      s.reportViewport(100, 30);
      await opening;
      expect(_screen(s), contains('last time'));
      final streamId = await ready(s);
      expect(_screen(s), contains('last time'), reason: 'until a screen lands');
      await s.handleBinary(_keyframe(streamId, text: 'now'));

      expect(s.showingKeptScreen, isFalse);
      expect(_screen(s), contains('now'));
      s.seedScreen(first.terminal);
      expect(s.showingKeptScreen, isFalse, reason: 'too late to stand in');
    });
  });

  group('a stream closed, taken or refused', () {
    test('closed for another stream is not this one\'s', () async {
      final (s, _) = await live();

      await s.handleFrame('terminal_closed', {'streamId': _streamId()});

      expect(s.status, TerminalSessionStatus.controlling);
    });

    test('closed by the machine, with its reason', () async {
      final (s, streamId) = await live();

      await s.handleFrame('terminal_closed', {
        'streamId': streamId,
        'reason': 'pane exited',
      });

      expect(s.status, TerminalSessionStatus.closed);
      expect(s.errorMessage, 'pane exited');
      expect(s.errorCode, isNull);
      expect(s.streamId, isNull);
    });

    test('taken, by someone named or not', () async {
      final (s, streamId) = await live();

      await s.handleFrame('terminal_closed', {
        'streamId': streamId,
        'code': 'TERMINAL_TAKEN_OVER',
      });

      expect(s.status, TerminalSessionStatus.takenOver);
      expect(s.errorMessage, 'Another client connected to this terminal.');
      expect(s.takenOverBy, isNull);
    });

    test('a lost socket does not overwrite a stream someone took', () async {
      final (s, streamId) = await live();
      await s.handleFrame('terminal_closed', {
        'streamId': streamId,
        'code': 'TERMINAL_TAKEN_OVER',
      });

      s.transportLost('gone');
      await s.handleFrame('terminal_transport_error', {'code': 'X'});

      expect(s.status, TerminalSessionStatus.takenOver);
    });

    test('an error about another stream or open is not this one\'s', () async {
      final (s, _) = await live();

      await s.handleFrame('terminal_error', {
        'streamId': _streamId(),
        'code': 'BOOM',
      });
      await s.handleFrame('terminal_error', {
        'requestId': 'other',
        'code': 'BOOM',
      });

      expect(s.status, TerminalSessionStatus.controlling);
    });

    test(
      'an error for this stream fails it with the daemon\'s words',
      () async {
        final (s, streamId) = await live();

        await s.handleFrame('terminal_error', {
          'streamId': streamId,
          'code': 'TERMINAL_PASTE_FAILED',
          'message': 'pty write failed',
        });

        expect(s.status, TerminalSessionStatus.error);
        expect(s.errorCode, 'TERMINAL_PASTE_FAILED');
        expect(s.errorMessage, 'pty write failed');
      },
    );

    test('an error with no code is still an error', () async {
      final (s, _) = await live();

      await s.handleFrame('terminal_error', {});

      expect(s.errorCode, 'TERMINAL_ERROR');
    });

    test('a refused paste leaves the stream alone', () async {
      final (s, streamId) = await live();

      await s.handleFrame('terminal_error', {
        'streamId': streamId,
        'code': 'TERMINAL_PASTE_INVALID',
      });

      expect(s.status, TerminalSessionStatus.controlling);
    });

    test(
      'a refused keystroke realigns the count once, not per refusal',
      () async {
        final (s, streamId) = await live();
        for (final key in ['a', 'b', 'c']) {
          s.terminal.textInput(key);
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        expect(_inputSeqs(wire), [0, 1, 2]);

        for (var i = 0; i < 2; i++) {
          await s.handleFrame('terminal_error', {
            'streamId': streamId,
            'code': 'TERMINAL_INPUT_INVALID',
            'expectedSeq': 1,
          });
        }
        s.terminal.textInput('d');
        await Future<void>.delayed(const Duration(milliseconds: 10));

        expect(_inputSeqs(wire).last, 1);
        expect(s.status, TerminalSessionStatus.controlling);
      },
    );

    test(
      'a refused keystroke from a daemon that does not say reopens',
      () async {
        final (s, streamId) = await live();

        await s.handleFrame('terminal_error', {
          'streamId': streamId,
          'code': 'TERMINAL_INPUT_INVALID',
        });
        await Future<void>.delayed(Duration.zero);

        expect(wire.last('terminal_close'), {'streamId': streamId});
        expect(wire.of('terminal_open'), hasLength(2));
      },
    );

    test('a polite open refused waits for a person', () async {
      final s = session(takeover: false);
      await s.open();

      await s.handleFrame('terminal_error', {
        'requestId': wire.last('terminal_open')['requestId'],
        'code': 'CONTROL_LEASE_HELD',
      });

      expect(s.status, TerminalSessionStatus.takenOver);
      expect(s.errorMessage, 'Another client controls this terminal.');
      expect(wire.of('terminal_open'), hasLength(1));
    });

    test(
      'a polite open refused after a person arrived asks again, properly',
      () async {
        final s = session(takeover: false);
        await s.open();
        s.takeover = true;

        await s.handleFrame('terminal_error', {
          'requestId': wire.last('terminal_open')['requestId'],
          'code': 'CONTROL_LEASE_HELD',
        });
        await Future<void>.delayed(Duration.zero);

        expect(wire.of('terminal_open'), hasLength(2));
        expect(wire.last('terminal_open').containsKey('takeover'), isFalse);
      },
    );

    test('an ordinary open that lost the race keeps its retry', () async {
      final s = session();
      await s.open();

      await s.handleFrame('terminal_error', {
        'requestId': wire.last('terminal_open')['requestId'],
        'code': 'CONTROL_LEASE_HELD',
      });

      expect(s.status, TerminalSessionStatus.error);
    });

    test(
      'the link\'s mode is shown only when it is one the header can draw',
      () async {
        final (s, streamId) = await live();

        await s.handleFrame('terminal_link_mode', {
          'streamId': streamId,
          'mode': 'p2p',
        });
        expect(s.linkMode, 'p2p');
        await s.handleFrame('terminal_link_mode', {
          'streamId': streamId,
          'mode': 'carrier-pigeon',
        });
        expect(s.linkMode, 'p2p');
        await s.handleFrame('terminal_link_mode', {
          'streamId': _streamId(),
          'mode': 'relay',
        });
        expect(s.linkMode, 'p2p');
      },
    );

    test(
      'an unknown frame is not the session\'s; a disposed one hears nothing',
      () async {
        final s = session(disposeAtEnd: false);

        expect(await s.handleFrame('terminal_whatever', {}), isFalse);
        s.dispose();
        expect(await s.handleFrame('terminal_ready', {}), isFalse);
        await s.open();
        await s.reopen();
        expect(wire.of('terminal_open'), isEmpty);
      },
    );
  });

  group('reopening and closing', () {
    test(
      'a stream on its way or alive is not reopened, unless forced',
      () async {
        final (s, _) = await live();

        await s.reopen();
        expect(wire.of('terminal_open'), hasLength(1));

        await s.reopen(force: true);
        expect(wire.of('terminal_open'), hasLength(2));
        expect(s.status, TerminalSessionStatus.opening);
        expect(_screen(s), contains('prompt>'), reason: 'the screen is kept');
      },
    );

    test('a dead stream reopens at the measured size', () async {
      final (s, _) = await live();
      s.reportViewport(100, 30);
      s.transportLost('gone');

      await s.reopen();

      expect(wire.last('terminal_open')['cols'], 100);
      expect(wire.last('terminal_open')['rows'], 30);
    });

    test('closing says so to the daemon, once there is a stream', () async {
      final (s, streamId) = await live();

      await s.close();
      await s.close();

      expect(wire.of('terminal_close'), [
        {'streamId': streamId},
      ]);
      expect(s.status, TerminalSessionStatus.closed);
      s.transportLost('late');
      expect(s.status, TerminalSessionStatus.closed);
    });

    test('a rename is trimmed, and said only when it changes', () async {
      final s = session();
      var told = 0;
      s.addListener(() => told++);

      s.renameAgent('  api ');
      s.renameAgent('api');
      s.renameAgent('   ');

      expect(s.agentName, 'api');
      expect(told, 1);
    });
  });

  group('what is typed', () {
    test('goes out numbered, and nothing before the stream is live', () async {
      final s = session();
      await s.open();
      s.terminal.textInput('early');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(wire.binaries, isEmpty);

      final streamId = await ready(s);
      await s.handleBinary(_keyframe(streamId));
      s.terminal.textInput('l');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      s.terminal.textInput('s\r');
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(_typed(wire), 'ls\r');
      expect(_inputSeqs(wire), [0, 1]);
    });

    test('an armed ctrl turns the next key into its chord, once', () async {
      final (s, _) = await live();

      s.armControl(true);
      expect(s.controlArmed, isTrue);
      s.terminal.textInput('c');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      s.terminal.textInput('c');
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(_typed(wire), '\x03c');
      expect(s.controlArmed, isFalse);
    });

    test(
      'clearing the prompt is ctrl-E then ctrl-U, and the keyboard\'s buffer',
      () async {
        final (s, _) = await live();
        final viewport = _Viewport();
        s.attachViewport(viewport);

        s.clearPrompt();
        await until(() => _typed(wire).length == 2);

        expect(_typed(wire), '\x05\x15');
        expect(viewport.cleared, 1);
        s.detachViewport(_Viewport());
        s.resetInputBuffer();
        expect(
          viewport.cleared,
          2,
          reason: 'another view detaching changes nothing',
        );
        s.detachViewport(viewport);
        s.resetInputBuffer();
        expect(viewport.cleared, 2);
      },
    );

    test('a key that cannot be sent is a lost stream', () async {
      final (s, _) = await live();
      wire.binarySends = false;

      s.terminal.textInput('x');
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(s.status, TerminalSessionStatus.error);
      expect(s.errorMessage, 'Terminal input was not sent');
    });

    test('a paste too big for one frame is split, still in order', () async {
      final (s, _) = await live();
      final big = 'x' * (TerminalSession.kInputFrameMaxBytes + 10);

      s.terminal.textInput('$big\r');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      final frames = wire.binaries
          .where((f) => f.kind == TerminalBinaryKind.input)
          .toList();
      expect(frames.length, greaterThan(1));
      expect(
        frames.every(
          (f) => f.bytes.length <= TerminalSession.kInputFrameMaxBytes,
        ),
        isTrue,
      );
      expect(_typed(wire), '$big\r');
    });

    test('a composed message is one turn, not keystrokes', () async {
      final (s, _) = await live();

      expect(await s.sendComposerText('  '), isFalse);
      expect(await s.sendComposerText('fix it  \n'), isTrue);

      expect(wire.last('message'), {
        'content': 'fix it',
        'agentId': 'a',
        'mode': 'auto',
      });
      expect(wire.binaries, isEmpty);
    });

    test('a watcher sends no message', () async {
      final s = session();
      await s.open();
      await ready(s, readOnly: true);

      expect(await s.sendComposerText('hi'), isFalse);
      expect(await s.pasteText('hi'), isFalse);
    });

    test(
      'a paste is one frame; one that cannot be sent is a lost stream',
      () async {
        final (s, streamId) = await live();

        expect(await s.pasteText(''), isFalse);
        expect(await s.pasteText('line one\nline two'), isTrue);
        final paste = wire.binaries.single;
        expect(paste.kind, TerminalBinaryKind.paste);
        expect(paste.streamId, streamId);
        expect(utf8.decode(paste.bytes), 'line one\nline two');

        wire.binarySends = false;
        expect(await s.pasteText('again'), isFalse);
        expect(s.errorMessage, 'Terminal paste was not sent');
      },
    );
  });

  group('images and files', () {
    Future<void> answer(
      TerminalSession s,
      String type, [
      Map<String, dynamic> extra = const {},
    ]) => s.handleFrame(type, {'streamId': s.streamId, ...extra});

    test(
      'an image is announced, sent in chunks, and done when the daemon says',
      () async {
        final (s, streamId) = await live();
        final image = Uint8List(terminalUploadChunkBytes + 5);

        final pasting = s.pasteImage(image);
        await Future<void>.delayed(Duration.zero);
        expect(wire.last('terminal_chunked_upload_begin'), {
          'streamId': streamId,
          'uploadKind': 'image',
          'totalBytes': image.length,
        });
        expect(s.uploadProgress?.label, 'image');

        await answer(s, 'terminal_chunked_upload_begin_result', {
          'accepted': true,
        });
        await Future<void>.delayed(Duration.zero);
        final chunks = wire.binaries
            .where((f) => f.kind == TerminalBinaryKind.imagePaste)
            .toList();
        expect([for (final c in chunks) c.seq], [0, 1]);
        expect(chunks.first.bytes.length, terminalUploadChunkBytes);

        await answer(s, 'terminal_chunked_upload_progress', {
          'bytesWritten': 100,
          'totalBytes': image.length,
        });
        expect(s.uploadProgress!.bytesWritten, 100);
        expect(s.uploadProgress!.percent, closeTo(100 / image.length, 1e-9));

        await answer(s, 'terminal_paste_image_result');
        expect(await pasting, isTrue);
        expect(s.uploadProgress, isNull);
      },
    );

    test('a file carries its name', () async {
      final (s, _) = await live();

      final pasting = s.pasteFile('notes.md', Uint8List.fromList([1, 2]));
      await Future<void>.delayed(Duration.zero);
      expect(
        wire.last('terminal_chunked_upload_begin')['filename'],
        'notes.md',
      );
      expect(s.uploadProgress?.label, 'notes.md');
      await answer(s, 'terminal_chunked_upload_begin_result', {
        'accepted': true,
      });
      await Future<void>.delayed(Duration.zero);
      await answer(s, 'terminal_paste_file_result');

      expect(await pasting, isTrue);
      expect(await s.pasteFile('', Uint8List(1)), isFalse);
      expect(await s.pasteFile('x', Uint8List(0)), isFalse);
      expect(await s.pasteImage(Uint8List(0)), isFalse);
    });

    test('a refused announcement ends it', () async {
      final (s, _) = await live();

      final pasting = s.pasteImage(Uint8List(3));
      await Future<void>.delayed(Duration.zero);
      await answer(s, 'terminal_chunked_upload_begin_result', {
        'accepted': false,
      });

      expect(await pasting, isFalse);
      expect(s.uploadProgress, isNull);
    });

    test('one at a time, and cancelling says so', () async {
      final (s, streamId) = await live();

      final first = s.pasteImage(Uint8List(3));
      await Future<void>.delayed(Duration.zero);
      expect(await s.pasteImage(Uint8List(3)), isFalse);

      await s.cancelUpload();

      expect(await first, isFalse);
      expect(wire.last('terminal_chunked_upload_cancel'), {
        'streamId': streamId,
      });
      await s.cancelUpload();
      expect(wire.of('terminal_chunked_upload_cancel'), hasLength(1));
    });

    test('a stream lost mid-upload settles it at once', () async {
      final (s, _) = await live();

      final pasting = s.pasteImage(Uint8List(3));
      await Future<void>.delayed(Duration.zero);
      s.transportLost('gone');

      expect(await pasting, isFalse);
    });

    test(
      'a chunk the daemon calls malformed ends it and keeps the stream',
      () async {
        final (s, streamId) = await live();

        final pasting = s.pasteImage(Uint8List(3));
        await Future<void>.delayed(Duration.zero);
        await s.handleFrame('terminal_error', {
          'streamId': streamId,
          'code': 'TERMINAL_CHUNKED_UPLOAD_INVALID',
        });

        expect(await pasting, isFalse);
        expect(s.status, TerminalSessionStatus.controlling);
      },
    );

    test(
      'an announcement or chunk that cannot be sent is a lost stream',
      () async {
        final (s, _) = await live();
        wire.sends = false;
        expect(await s.pasteImage(Uint8List(3)), isFalse);
        expect(s.errorMessage, 'Terminal upload request was not sent');

        wire.sends = true;
        final (t, _) = await live();
        wire.binarySends = false;
        final pasting = t.pasteImage(Uint8List(3));
        await Future<void>.delayed(Duration.zero);
        await t.handleFrame('terminal_chunked_upload_begin_result', {
          'streamId': t.streamId,
          'accepted': true,
        });
        expect(await pasting, isFalse);
        expect(t.errorMessage, 'Terminal upload chunk was not sent');
      },
    );

    test('a daemon that never answers the announcement times it out', () {
      fakeAsync((async) {
        final s = session(disposeAtEnd: false);
        s.open();
        async.flushMicrotasks();
        s.handleFrame('terminal_ready', {
          'requestId': wire.last('terminal_open')['requestId'],
          'agentId': 'a',
          'protocolVersion': TerminalSession.protocolVersion,
          'streamId': _streamId(),
        });
        s.handleBinary(_keyframe(s.streamId!));
        async.flushMicrotasks();
        bool? result;
        s.pasteImage(Uint8List(3)).then((value) => result = value);

        async.elapse(const Duration(seconds: 11));

        expect(result, isFalse);
        s.dispose();
      });
    });

    test('frames about an upload on another stream are ignored', () async {
      final (s, _) = await live();
      final other = _streamId();

      for (final type in [
        'terminal_chunked_upload_begin_result',
        'terminal_chunked_upload_progress',
        'terminal_paste_image_result',
      ]) {
        expect(await s.handleFrame(type, {'streamId': other}), isTrue);
      }
      expect(s.uploadProgress, isNull);
    });
  });

  group('size and scrolling', () {
    test('the first resize goes at once; a drag is asked for once, where it settles', () async {
      final (s, streamId) = await live();

      s.resize(100, 30);
      await Future<void>.delayed(Duration.zero);
      s.resize(110, 31);
      s.resize(120, 32);
      await Future<void>.delayed(const Duration(milliseconds: 80));

      final sizes = [
        for (final r in wire.of('terminal_resize')) (r['cols'], r['rows']),
      ];
      expect(sizes, [(100, 30), (120, 32)]);
      expect(wire.last('terminal_resize')['streamId'], streamId);
      expect(wire.last('terminal_resize')['resizeSeq'], 1);
    });

    test('a resize to the size it already is sends nothing', () async {
      final (s, _) = await live();

      s.resize(80, 24);
      await Future<void>.delayed(Duration.zero);

      expect(wire.of('terminal_resize'), isEmpty);
    });

    test('a resize that cannot be sent is a lost stream', () async {
      final (s, _) = await live();
      wire.sends = false;

      s.resize(100, 30);
      await Future<void>.delayed(Duration.zero);

      expect(s.errorMessage, 'Terminal resize was not sent');
    });

    test(
      'the measured size is asked for as soon as the screen lands',
      () async {
        final s = session();
        await s.open();
        s.reportViewport(90, 30);
        final streamId = await ready(s);

        await s.handleBinary(_keyframe(streamId));
        await Future<void>.delayed(Duration.zero);

        expect(wire.last('terminal_resize')['cols'], 90);
      },
    );

    test('Grok\'s scroll goes to tmux, coalesced, flushed on a turn', () async {
      final (s, streamId) = await live(engine: 'grok');

      s.sendScrollCommand(true, 2);
      s.sendScrollCommand(true, 3);
      s.sendScrollCommand(false, 1);
      await Future<void>.delayed(const Duration(milliseconds: 40));
      s.sendScrollCommand(true, 0);

      expect(wire.of('terminal_scroll'), [
        {'streamId': streamId, 'direction': 'up', 'lines': 5},
        {'streamId': streamId, 'direction': 'down', 'lines': 1},
      ]);
    });

    test('any other engine scrolls its own copy', () async {
      final (s, _) = await live();
      final viewport = _Viewport();
      s.attachViewport(viewport);

      s.sendScrollCommand(true, 3);
      s.scroll(1, 10, 0);
      expect(s.focusInput(), isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(wire.of('terminal_scroll'), isEmpty);
      expect(viewport.scrolls, [(1, 10, 0)]);
    });

    test('the cursor blinks locally, never into the stream', () async {
      final (s, _) = await live();

      s.setCursorBlinkPhase(false);
      expect(s.terminal.cursorVisibleMode, isFalse);
      s.setCursorBlinkPhase(false);
      s.setCursorBlinkPhase(true);
      expect(s.terminal.cursorVisibleMode, isTrue);
      expect(wire.binaries, isEmpty);
    });

    test('an acknowledgement that cannot be sent is a lost stream', () async {
      final (s, streamId) = await live();
      wire.sends = false;

      await s.handleBinary(_output(streamId, 1, 'x'));
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(s.errorMessage, 'Terminal ACK was not sent');
    });

    test('a large burst is acknowledged at once, not on the timer', () async {
      final (s, streamId) = await live();
      final before = wire.of('terminal_ack').length;

      await s.handleBinary(_output(streamId, 1, 'y' * (64 * 1024)));

      expect(wire.of('terminal_ack').length, before + 1);
    });
  });

  group('who a client is', () {
    test('only a well-formed introduction is believed', () {
      expect(TerminalClientDescriptor.fromJson(null), isNull);
      expect(
        TerminalClientDescriptor.fromJson({'kind': 'Desk top', 'name': 'x'}),
        isNull,
      );
      expect(
        TerminalClientDescriptor.fromJson({'kind': 'desktop', 'name': 3}),
        isNull,
      );
      expect(
        TerminalClientDescriptor.fromJson({'kind': 'desktop', 'name': '  '}),
        isNull,
      );
      expect(
        TerminalClientDescriptor.fromJson({
          'kind': 'desktop',
          'name': 'x' * (TerminalClientDescriptor.nameMax + 1),
        }),
        isNull,
      );
      expect(
        TerminalClientDescriptor.fromJson({
          'kind': 'desktop',
          'name': 'Mac',
          'machineId': 'not-hex',
        }),
        isNull,
      );

      final mac = TerminalClientDescriptor.fromJson({
        'kind': 'desktop',
        'name': 'Mac\u0007 mini',
        'machineId': 'a' * 16,
      })!;
      expect(mac.name, 'Mac  mini');
      expect(mac.toJson()['machineId'], 'a' * 16);
    });

    test('a desktop is named as the fleet names its machine now', () {
      final mac = TerminalClientDescriptor(
        kind: 'desktop',
        name: 'old name',
        machineId: 'a' * 16,
      );

      expect(mac.label((_) => ' Studio '), 'Studio');
      expect(mac.label((_) => null), 'old name');
      expect(mac.label((_) => '  '), 'old name');
      expect(
        const TerminalClientDescriptor(
          kind: 'phone',
          name: 'Pat',
        ).label((_) => 'never asked'),
        'Pat',
      );
    });

    test('an upload\'s progress never reads past the ends', () {
      const empty = UploadProgress(label: 'x', bytesWritten: 5, totalBytes: 0);
      expect(empty.percent, 0);
      final over = empty.copyWith(totalBytes: 2);
      expect(over.percent, 1);
      expect(over.copyWith().bytesWritten, 5);
    });
  });
}

/// The session's two send channels, recorded.
class _Wire {
  final frames = <(String, Map<String, dynamic>)>[];
  final binaries = <TerminalBinaryFrame>[];
  bool sends = true;
  bool binarySends = true;

  Future<bool> send(String type, Map<String, dynamic> payload) async {
    frames.add((type, payload));
    return sends;
  }

  Future<bool> sendBinary(TerminalBinaryFrame frame) async {
    binaries.add(frame);
    return binarySends;
  }

  List<Map<String, dynamic>> of(String type) => [
    for (final (sent, payload) in frames)
      if (sent == type) payload,
  ];

  Map<String, dynamic> last(String type) => of(type).last;
}

class _Viewport implements TerminalViewport {
  final scrolls = <(int, int, int)>[];
  var cleared = 0;

  @override
  void scroll(int phase, int dy, int velocity) =>
      scrolls.add((phase, dy, velocity));

  @override
  bool focusInput() => true;

  @override
  void clearInputBuffer() => cleared++;
}

var _streams = 0;

String _streamId() =>
    '00000000-0000-4000-8000-${(++_streams).toString().padLeft(12, '0')}';

TerminalBinaryFrame _keyframe(
  String streamId, {
  int seq = 0,
  String text = 'prompt> ',
  List<int>? bytes,
  bool compressed = false,
}) => TerminalBinaryFrame(
  kind: TerminalBinaryKind.keyframe,
  streamId: streamId,
  seq: seq,
  bytes: Uint8List.fromList(bytes ?? utf8.encode(text)),
  compressed: compressed,
  cols: 80,
  rows: 24,
);

TerminalBinaryFrame _output(
  String streamId,
  int seq,
  String? text, {
  List<int>? bytes,
  bool compressed = false,
}) => TerminalBinaryFrame(
  kind: TerminalBinaryKind.output,
  streamId: streamId,
  seq: seq,
  bytes: Uint8List.fromList(bytes ?? utf8.encode(text!)),
  compressed: compressed,
);

TerminalBinaryFrame _sync(String streamId, int seq) => TerminalBinaryFrame(
  kind: TerminalBinaryKind.sync,
  streamId: streamId,
  seq: seq,
  bytes: Uint8List(0),
  compressed: false,
);

/// Everything on the session's screen, as text.
String _screen(TerminalSession s) {
  final buffer = s.terminal.buffer;
  return [
    for (var i = 0; i < buffer.lines.length; i++)
      buffer.lines[i].toString().trimRight(),
  ].join('\n');
}

String _typed(_Wire wire) => utf8.decode([
  for (final frame in wire.binaries)
    if (frame.kind == TerminalBinaryKind.input) ...frame.bytes,
]);

List<int> _inputSeqs(_Wire wire) => [
  for (final frame in wire.binaries)
    if (frame.kind == TerminalBinaryKind.input) frame.seq,
];
