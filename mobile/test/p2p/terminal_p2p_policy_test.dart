import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/p2p/terminal_p2p_policy.dart';

void main() {
  test('null unless enabled at this protocol version', () {
    expect(TerminalP2pPolicy.parse(null), isNull);
    expect(
      TerminalP2pPolicy.parse({'enabled': false, 'protocolVersion': 1}),
      isNull,
    );
    expect(
      TerminalP2pPolicy.parse({'enabled': true, 'protocolVersion': 2}),
      isNull,
    );
    expect(
      TerminalP2pPolicy.parse({'enabled': true, 'protocolVersion': 1}),
      isNotNull,
    );
  });

  test('keeps only stun urls, at most ten, in order', () {
    final policy = TerminalP2pPolicy.parse({
      'enabled': true,
      'protocolVersion': 1,
      'stunUrls': [
        'stun:a',
        'turn:b',
        7,
        'STUNS:c',
        for (var i = 0; i < 12; i++) 'stun:many$i',
      ],
    })!;
    expect(policy.stunUrls.length, 10);
    expect(policy.stunUrls.take(2), ['stun:a', 'STUNS:c']);
  });

  test('openWaitMs defaults to 1500 and clamps to 0..5000', () {
    TerminalP2pPolicy parse(Object? wait) => TerminalP2pPolicy.parse({
      'enabled': true,
      'protocolVersion': 1,
      'openWaitMs': wait,
    })!;
    expect(parse(null).openWaitMs, 1500);
    expect(parse('x').openWaitMs, 1500);
    expect(parse(-5).openWaitMs, 0);
    expect(parse(9000).openWaitMs, 5000);
    expect(parse(2500.4).openWaitMs, 2500);
  });

  test('a malformed turn block degrades to stun-only', () {
    TerminalP2pTurn? turn(Object? raw) => TerminalP2pPolicy.parse({
      'enabled': true,
      'protocolVersion': 1,
      'turn': raw,
    })!.turn;
    expect(turn(null), isNull);
    expect(
      turn({
        'urls': ['turn:x'],
        'username': '',
        'credential': 'c',
      }),
      isNull,
    );
    expect(
      turn({
        'urls': ['turn:x'],
        'username': 'u',
      }),
      isNull,
    );
    expect(
      turn({
        'urls': ['stun:x'],
        'username': 'u',
        'credential': 'c',
      }),
      isNull,
    );
    expect(
      turn({
        'urls': ['turn:x'],
        'username': 'u' * 513,
        'credential': 'c',
      }),
      isNull,
    );
    final ok = turn({
      'urls': ['turn:x?transport=udp', 'turns:y:443', 'stun:z', 'turn:9'],
      'username': 'u',
      'credential': 'c',
    })!;
    expect(ok.urls, ['turn:x?transport=udp', 'turns:y:443', 'turn:9']);
    expect(ok.toJson(), {
      'urls': ['turn:x?transport=udp', 'turns:y:443', 'turn:9'],
      'username': 'u',
      'credential': 'c',
    });
  });
}
