import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:harness_mobile/e2ee/keys.dart';

import '../e2ee/machine_session.dart';
import 'memory_web_socket.dart';

/// One socket a phone opened to the [FakeRelay], and the machine behind it.
class RelayLink {
  RelayLink(this.ws, this.protocol);

  final MemoryWebSocket ws;
  final String protocol;

  /// Every JSON frame the phone sent on this socket, as sent (sealed payloads stay sealed).
  final frames = <Map<String, dynamic>>[];

  /// Every binary frame the phone sent.
  final binary = <Uint8List>[];

  /// The machine's end of the session, once the phone's hello has been answered.
  MachineSession? machine;

  /// Sent if the socket is still open; a machine answering a phone that already hung up says
  /// nothing to anyone.
  void send(Map<String, dynamic> frame) {
    try {
      ws.sink.add(jsonEncode(frame));
    } on StateError {
      // Already hung up.
    }
  }

  void sendText(String text) => ws.sink.add(text);

  void sendBytes(List<int> bytes) => ws.sink.add(bytes);

  Future<void> close([int? code, String? reason]) => ws.close(code, reason);

  /// The frames of [type] the phone sent, opened where they were sealed.
  List<Map<String, dynamic>> opened(String type) => [
    for (final frame in frames)
      if (frame['type'] == type)
        machine?.openDown(frame) ?? (frame['payload'] as Map<String, dynamic>),
  ];
}

/// An in-memory relay with no network access — with the machine at the far end of it
/// played the way `manager.ts` plays it: `connected` for the select, a signed welcome for the
/// hello. Each hook lets a test replace one step with something broken or hostile.
class FakeRelay {
  FakeRelay._(this.machineIdentity);
  final E2eeIdentity machineIdentity;
  final links = <RelayLink>[];
  int get opened => links.length;

  /// Refuse the upgrade itself.
  bool refuse = false;

  /// Close each new socket with this code as soon as the phone selects.
  int? closeOnSelect;

  /// Never answer the select.
  bool silentOnSelect = false;

  /// Answer the hello with `e2e_denied` instead.
  bool deny = false;

  /// Answers the hello instead of the machine; null means the machine's own welcome.
  Future<Map<String, dynamic>?> Function(
    RelayLink link,
    Map<String, dynamic> hello,
  )?
  onHello;

  /// Called with every frame after the defaults above have run.
  void Function(RelayLink link, Map<String, dynamic> frame)? onFrame;

  final _linked = StreamController<RelayLink>.broadcast();
  final _ready = StreamController<RelayLink>.broadcast();

  /// The next socket to open.
  Future<RelayLink> nextLink() => _linked.stream.first;

  /// The next socket whose session the machine has welcomed.
  Future<RelayLink> nextSession() => _ready.stream.first;

  String get url => 'ws://relay.invalid';

  static Future<FakeRelay> start(E2eeIdentity machineIdentity) async =>
      FakeRelay._(machineIdentity);

  /// Every URL dialled, in order.
  final dialledUris = <Uri>[];

  MemoryWebSocket connect(Uri uri, {Iterable<String>? protocols}) {
    dialledUris.add(uri);
    final (client, server) = MemoryWebSocket.pair(
      protocol: protocols?.firstOrNull,
    );
    unawaited(_serve(client, server));
    return client;
  }

  /// When set, a dial waits here before its upgrade is answered — a slow network's handshake.
  Completer<void>? holdUpgrade;

  /// Completes when a dial has reached the relay (and is being held, if [holdUpgrade] is set).
  final dialled = StreamController<void>.broadcast();

  Future<void> _serve(MemoryWebSocket client, MemoryWebSocket server) async {
    dialled.add(null);
    final hold = holdUpgrade;
    if (hold != null) await hold.future;
    if (refuse) {
      client.reject();
      await client.close();
      return;
    }
    client.accept();
    final link = RelayLink(server, server.protocol ?? '');
    links.add(link);
    _linked.add(link);
    server.stream.listen(
      (data) => unawaited(_receive(link, data)),
      onError: (_) {},
      cancelOnError: false,
    );
  }

  Future<void> _receive(RelayLink link, Object? data) async {
    if (data is List<int>) {
      link.binary.add(Uint8List.fromList(data));
      return;
    }
    final frame = jsonDecode(data as String) as Map<String, dynamic>;
    link.frames.add(frame);
    switch (frame['type']) {
      case 'machine_select':
        final code = closeOnSelect;
        if (code != null) {
          await link.close(code, 'rejected');
          return;
        }
        if (silentOnSelect) break;
        link.send({
          'type': 'connected',
          'payload': {
            'machineId': (frame['payload'] as Map)['machineId'],
            'p2p': {'enabled': true},
          },
        });
      case 'e2e_hello':
        if (deny) {
          link.send({
            'type': 'e2e_denied',
            'payload': {'reason': 'unpaired'},
          });
          break;
        }
        final machine = link.machine = await MachineSession.answer(
          frame,
          identity: machineIdentity,
        );
        final custom = onHello;
        final welcome = custom == null ? null : await custom(link, frame);
        link.send({
          'type': 'e2e_welcome',
          'payload': welcome ?? await machine.welcome(),
        });
        _ready.add(link);
    }
    onFrame?.call(link, frame);
  }

  Future<void> stop() async {
    for (final link in links) {
      await link.ws.close();
    }
    await _linked.close();
    await _ready.close();
    await dialled.close();
  }
}
