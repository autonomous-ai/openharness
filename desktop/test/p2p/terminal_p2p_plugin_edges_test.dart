import 'dart:convert';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/p2p/terminal_p2p_link.dart';
import 'package:harness/web/p2p/terminal_p2p_plugin.dart';
import 'package:harness/web/p2p/terminal_p2p_policy.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/terminal_transport_plugin.dart';

import 'fakes.dart';

void flush(FakeAsync async) => async.flushMicrotasks();

Map<String, dynamic> ready(String streamId, String requestId) => {
  'type': 'terminal_ready',
  'payload': {'streamId': streamId, 'requestId': requestId, 'agentId': 'a'},
};

/// A link whose send buffer is full: a binary send waits out [drain] and then fails.
class _BackedUpLink extends FakeTerminalP2pLink {
  _BackedUpLink({
    required super.policy,
    required super.sendSignal,
    required super.onData,
    super.onState,
    super.onUnavailable,
    super.upgrade,
    required super.sessionId,
  });

  @override
  Future<bool> sendWithBackpressureRetry(
    Object data, {
    Duration drain = const Duration(seconds: 5),
  }) => Future<bool>.delayed(const Duration(milliseconds: 80), () => false);
}

/// [FakeLinkFactory], but its links report their negotiation steps, and can be backed up.
class _Links extends FakeLinkFactory {
  bool backedUp = false;
  final steps = <String>[];

  @override
  TerminalP2pLink create({
    required TerminalP2pPolicy policy,
    required TerminalP2pSignalSink sendSignal,
    required TerminalP2pDataSink onData,
    TerminalP2pStateSink? onState,
    void Function(String reason)? onUnavailable,
    void Function(String step, Duration elapsed)? onStep,
    bool upgrade = false,
  }) {
    onStep?.call('offer-created', const Duration(milliseconds: 5));
    steps.add(upgrade ? 'upgrade' : 'primary');
    if (!backedUp) {
      return super.create(
        policy: policy,
        sendSignal: sendSignal,
        onData: onData,
        onState: onState,
        onUnavailable: onUnavailable,
        onStep: onStep,
        upgrade: upgrade,
      );
    }
    final link = _BackedUpLink(
      policy: policy,
      sendSignal: sendSignal,
      onData: onData,
      onState: onState,
      onUnavailable: onUnavailable,
      upgrade: upgrade,
      sessionId: 'backed-up-${created.length + 1}',
    );
    created.add(link);
    return link;
  }
}

({TerminalP2pPlugin plugin, FakeHost host, _Links links}) boot(
  FakeAsync async,
) {
  final host = FakeHost();
  final links = _Links();
  final epoch = DateTime(2026, 9, 14);
  final plugin = TerminalP2pPlugin(
    host: host,
    machineId: 'machine-1',
    links: links,
    now: () => async.getClock(epoch).now(),
  );
  host.plugin = plugin;
  plugin.onConnectedAck({'machineId': 'machine-1', 'p2p': enabledPolicy});
  plugin.onSessionReady();
  return (plugin: plugin, host: host, links: links);
}

/// A stream open over the channel on [link].
void openOverP2p(
  FakeAsync async,
  FakeHost host,
  FakeTerminalP2pLink link, {
  String stream = streamA,
  String requestId = 'r1',
}) {
  host.sendTerminalFrame('terminal_open', {'requestId': requestId});
  flush(async);
  link.receive(jsonEncode(ready(stream, requestId)));
  flush(async);
}

void main() {
  group('the set of live plugins', () {
    test('holds each plugin until it is disposed, and kicks them all', () {
      fakeAsync((async) {
        final links = FakeLinkFactory();
        final plugins = TerminalP2pPlugins(links: links);
        final hostA = FakeHost(), hostB = FakeHost();
        final a = plugins.create(hostA, 'a') as TerminalP2pPlugin;
        final b = plugins.create(hostB, 'b') as TerminalP2pPlugin;
        hostA.plugin = a;
        hostB.plugin = b;
        expect(plugins.liveCount, 2);

        for (final plugin in [a, b]) {
          plugin.onConnectedAck({'p2p': enabledPolicy});
          plugin.onSessionReady();
        }
        // Both fail to negotiate; both wait out a retry.
        links.created[0].failNegotiation('peer_failed');
        links.created[1].failNegotiation('peer_failed');
        flush(async);
        expect(links.created, hasLength(2));
        plugins.kickRetry();
        expect(
          links.created,
          hasLength(4),
          reason: 'every live plugin retried at once',
        );

        a.dispose();
        expect(plugins.liveCount, 1);
        b.dispose();
        expect(plugins.liveCount, 0);
        plugins.kickRetry();
        expect(links.created, hasLength(4));
      });
    });
  });

  group('stream bookkeeping', () {
    test('an open that errors is no longer waiting on the channel', () {
      fakeAsync((async) {
        final b = boot(async);
        b.links.last.open();
        flush(async);
        b.host.sendTerminalFrame('terminal_open', {'requestId': 'r1'});
        flush(async);
        b.links.last.receive(
          jsonEncode({
            'type': 'terminal_error',
            'payload': {'requestId': 'r1', 'error': 'NO_AGENT'},
          }),
        );
        flush(async);
        // A late ready for the same request is not taken as a p2p stream.
        b.host.receiveWs(ready(streamA, 'r1'));
        flush(async);
        expect(b.plugin.linkModeFor(streamA), 'relay');
        b.plugin.dispose();
      });
    });

    test('a stream the machine closed over the channel is forgotten', () {
      fakeAsync((async) {
        final b = boot(async);
        b.links.last.open();
        flush(async);
        openOverP2p(async, b.host, b.links.last);
        expect(b.plugin.linkModeFor(streamA), 'p2p');
        b.links.last.receive(
          jsonEncode({
            'type': 'terminal_closed',
            'payload': {'streamId': streamA},
          }),
        );
        flush(async);
        expect(b.plugin.linkModeFor(streamA), 'relay');
        b.plugin.dispose();
      });
    });

    test(
      'closing a stream the channel refused falls to the socket and forgets it',
      () {
        fakeAsync((async) {
          final b = boot(async);
          b.links.last.open();
          flush(async);
          openOverP2p(async, b.host, b.links.last);
          b.links.last.acceptSends = false;
          b.host.sendTerminalFrame('terminal_close', {'streamId': streamA});
          flush(async);
          expect(b.host.wsTypes, contains('terminal_close'));
          expect(b.plugin.linkModeFor(streamA), 'relay');
          b.plugin.dispose();
        });
      },
    );

    test(
      'a forced channel send with no channel abandons only that migration',
      () {
        fakeAsync((async) {
          final b = boot(async);
          // No channel is up: a forced send is still the plugin's, and dropped.
          expect(
            b.plugin.sendJson(
              'terminal_resync',
              {'streamId': streamA},
              '{}',
              openViaPlugin: false,
              force: TransportVia.plugin,
            ),
            isTrue,
          );
          expect(b.plugin.linkModeFor(streamA), 'relay');
          b.plugin.dispose();
        });
      },
    );
  });

  group('backpressure', () {
    test('a channel that stays backed up demotes the stream to the socket', () {
      fakeAsync((async) {
        final host = FakeHost();
        final links = _Links()..backedUp = true;
        final epoch = DateTime(2026, 9, 14);
        final plugin = TerminalP2pPlugin(
          host: host,
          machineId: 'm',
          links: links,
          now: () => async.getClock(epoch).now(),
        );
        host.plugin = plugin;
        plugin.onConnectedAck({'p2p': enabledPolicy});
        plugin.onSessionReady();
        final link = links.last;
        link.open();
        flush(async);
        openOverP2p(async, host, link);
        expect(plugin.linkModeFor(streamA), 'p2p');

        bool? sent;
        plugin
            .sendBinary(htrl(TerminalBinaryKind.input, streamA), Uint8List(4))
            .then((value) => sent = value);
        async.elapse(const Duration(milliseconds: 100));
        flush(async);
        expect(sent, isFalse, reason: 'the socket carries it instead');
        expect(plugin.linkModeFor(streamA), 'relay');
        expect(host.dispatched.last, linkMode(streamA, 'relay'));
        plugin.dispose();
      });
    });
  });

  group('an upgrade trial', () {
    ({FakeHost host, _Links links, TerminalP2pPlugin plugin}) onTurn(
      FakeAsync async,
    ) {
      final b = boot(async);
      b.links.last.open(transport: TerminalP2pTransport.relay);
      flush(async);
      openOverP2p(async, b.host, b.links.last);
      b.host.sends.clear();
      return (host: b.host, links: b.links, plugin: b.plugin);
    }

    test('signals for the trial reach the trial, not the live link', () {
      fakeAsync((async) {
        final b = onTurn(async);
        async.elapse(const Duration(seconds: 60));
        final shadow = b.links.last;
        expect(shadow.upgrade, isTrue);
        b.plugin.handleInbound('p2p_answer', {
          'sessionId': shadow.sessionId,
          'sdp': 'v=0',
        });
        b.plugin.handleInbound('p2p_answer', {
          'sessionId': b.links.first.sessionId,
          'sdp': 'v=0',
        });
        flush(async);
        expect(shadow.signals.single.$2['sessionId'], shadow.sessionId);
        expect(
          b.links.first.signals.single.$2['sessionId'],
          b.links.first.sessionId,
        );
        // A promote ack for anything but the live link is nobody's.
        b.plugin.handleInbound('p2p_promote_ack', {'sessionId': 'stranger'});
        flush(async);
        expect(b.links.steps, ['primary', 'upgrade']);
        b.plugin.dispose();
      });
    });

    test('a trial the old link never drains for is dropped, the live link untouched', () {
      fakeAsync((async) {
        final b = onTurn(async);
        final primary = b.links.first;
        async.elapse(const Duration(seconds: 60));
        final shadow = b.links.last;
        shadow.open();
        flush(async);
        // The drain resync went out; no keyframe comes back.
        async.elapse(const Duration(seconds: 6));
        flush(async);
        expect(shadow.stopReason, 'upgrade_drain_timeout');
        expect(primary.stopped, isFalse);
        expect(b.plugin.linkModeFor(streamA), 'turn');
        // And the next trial is scheduled as usual.
        async.elapse(const Duration(seconds: 60));
        expect(b.links.created, hasLength(3));
        b.plugin.dispose();
      });
    });

    test('a trial that dies mid-drain is let go of, and the drain with it', () {
      fakeAsync((async) {
        final b = onTurn(async);
        final primary = b.links.first;
        async.elapse(const Duration(seconds: 60));
        final shadow = b.links.last;
        shadow.open();
        flush(async);
        shadow.drop('peer_failed');
        flush(async);
        async.elapse(const Duration(seconds: 6));
        flush(async);
        expect(primary.stopped, isFalse);
        expect(b.plugin.linkModeFor(streamA), 'turn');
        b.plugin.dispose();
      });
    });
  });
}
