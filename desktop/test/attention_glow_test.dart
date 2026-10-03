// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/attention_state.dart';
import 'package:harness/widgets/attention_glow.dart';

Map<String, dynamic> frame(String state, {num? fraction}) => {
      'agents': [
        {'agentId': 'a', 'state': state, 'detail': 'Which branch?', if (fraction != null) 'spend': {'fraction': fraction}},
      ],
    };

void main() {
  test('AttentionState parses a frame, notifies once per real change, ignores junk', () {
    final s = AttentionState();
    var n = 0;
    s.addListener(() => n++);
    s.apply(frame('waiting', fraction: 0.5));
    s.apply(frame('waiting', fraction: 0.5));
    expect(n, 1);
    expect(s.of('a')?.state, AgentAttention.waiting);
    expect(s.of('a')?.spendFraction, 0.5);
    expect(s.of('a')?.needsYou, isTrue);
    s.apply({'agents': 'nope'});
    expect(n, 1);
    s.apply(frame('working'));
    expect(s.of('a')?.needsYou, isFalse);
    expect(attentionFromWire('mystery'), AgentAttention.idle);
  });

  testWidgets('AttentionGlow paints a steady 2 px frame under reduced motion, nothing when idle', (tester) async {
    final s = AttentionState();
    await tester.pumpWidget(MaterialApp(
      home: Center(child: AttentionGlow(attention: s, agentId: 'a', reducedMotion: true, child: const SizedBox(width: 100, height: 60))),
    ));
    AttentionBorderPainter? painter() => tester
        .widgetList<CustomPaint>(find.byType(CustomPaint))
        .map((w) => w.foregroundPainter)
        .whereType<AttentionBorderPainter>()
        .firstOrNull;
    expect(painter(), isNull);
    s.apply(frame('permission'));
    await tester.pump();
    expect(painter()!.reduced, isTrue);
    expect(AttentionBorderPainter.width, 2);
    expect(tester.getSize(find.byType(SizedBox)), const Size(100, 60));
    s.apply(frame('idle'));
    await tester.pump();
    expect(painter(), isNull);
  });
}
