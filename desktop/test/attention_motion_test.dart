// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/branding/boot_splash.dart';
import 'package:harness/branding/brand_prefs.dart';
import 'package:harness/fleet/fleet_graph.dart';
import 'package:harness/fleet/neon.dart';
import 'package:harness/fleet/spend_ring.dart';
import 'package:harness/state/attention_state.dart';
import 'package:harness/widgets/attention_glow.dart';

Map<String, dynamic> frame(String state, {num? fraction, num? usd, int at = 1}) => {
      'hostname': 'host-a',
      'at': at,
      'agents': [
        {
          'agentId': 'a',
          'name': 'planner-1',
          'machine': 'host-a',
          'lane': 'planner',
          'state': state,
          'detail': 'Which branch?',
          if (fraction != null || usd != null) 'spend': {'fraction': fraction, 'usd': usd},
        },
      ],
    };

AttentionBorderPainter? borderPainter(WidgetTester tester) {
  for (final w in tester.widgetList<CustomPaint>(find.byType(CustomPaint))) {
    if (w.foregroundPainter is AttentionBorderPainter) return w.foregroundPainter as AttentionBorderPainter;
  }
  return null;
}

Widget pane(AttentionState s, {bool reduced = false}) => MaterialApp(
      home: Center(
        child: AttentionGlow(attention: s, agentId: 'a', reducedMotion: reduced, child: const SizedBox(width: 200, height: 120)),
      ),
    );

void main() {
  tearDown(() => Motion.override = null);

  group('attention rows', () {
    test('carry name, machine, lane and usd; a frame that only moves `at` notifies nobody', () {
      final s = AttentionState();
      var n = 0;
      s.addListener(() => n++);
      s.apply(frame('working', fraction: 0.4, usd: 2.5, at: 1));
      s.apply(frame('working', fraction: 0.4, usd: 2.5, at: 2));
      expect(n, 1);
      final r = s.of('a')!;
      expect((r.name, r.machine, r.lane, r.spendUsd, r.glyph, r.label), ('planner-1', 'host-a', 'planner', 2.5, '~', 'working'));
      expect(s.hostname, 'host-a');
    });
  });

  group('neon', () {
    test('a theme colour is used only while it still reads as that colour', () {
      Color? greenRed(String _) => const Color(0xFF50F872);
      Color? realRed(String _) => const Color(0xFFFF3355);
      expect(Neon.themed('red', Neon.fallbackRed, 335, 20, read: greenRed), Neon.fallbackRed);
      expect(Neon.themed('red', Neon.fallbackRed, 335, 20, read: realRed), const Color(0xFFFF3355));
      expect(Neon.themed('red', Neon.fallbackRed, 335, 20, read: (_) => null), Neon.fallbackRed);
    });

    test('spend colour: accent, amber from 80 percent, red at the cap', () {
      const n = Neon(accent: Color(0xFF00FFFF), yellow: Color(0xFFFFFF00), red: Color(0xFFFF0000), green: Color(0xFF00FF00), foreground: Colors.white, background: Colors.black);
      expect(n.spend(0.5), n.accent);
      expect(n.spend(0.8), n.yellow);
      expect(n.spend(1.0), n.red);
      expect(n.spend(1.4), n.red);
    });
  });

  group('pane attention', () {
    test('every state maps to one motion', () {
      expect(AttentionGlow.motionFor(AgentAttention.working), AttentionMotion.sweep);
      expect(AttentionGlow.motionFor(AgentAttention.waiting), AttentionMotion.breathe);
      expect(AttentionGlow.motionFor(AgentAttention.permission), AttentionMotion.alarm);
      expect(AttentionGlow.motionFor(AgentAttention.failed), AttentionMotion.alarm);
      expect(AttentionGlow.motionFor(AgentAttention.done), AttentionMotion.fill);
      expect(AttentionGlow.motionFor(AgentAttention.idle), AttentionMotion.none);
      expect(AttentionGlow.motionFor(AgentAttention.offline), AttentionMotion.none);
    });

    testWidgets('idle paints nothing and schedules no frames', (tester) async {
      final s = AttentionState();
      await tester.pumpWidget(pane(s));
      expect(borderPainter(tester), isNull);
      s.apply(frame('idle'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(borderPainter(tester), isNull);
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('working sweeps, waiting breathes, permission alarms; child never resized', (tester) async {
      final s = AttentionState();
      await tester.pumpWidget(pane(s));
      for (final (wire, motion) in [('working', AttentionMotion.sweep), ('waiting', AttentionMotion.breathe), ('permission', AttentionMotion.alarm)]) {
        s.apply(frame(wire));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        final p = borderPainter(tester)!;
        expect(p.motion, motion, reason: wire);
        expect(tester.binding.hasScheduledFrame, isTrue, reason: '$wire loops');
        expect(tester.getSize(find.byType(SizedBox).last), const Size(200, 120));
      }
    });

    testWidgets('done plays its fill once, then stops asking for frames', (tester) async {
      final s = AttentionState();
      await tester.pumpWidget(pane(s));
      s.apply(frame('working'));
      await tester.pump();
      s.apply(frame('done'));
      await tester.pump();
      expect(borderPainter(tester)!.motion, AttentionMotion.fill);
      await tester.pump(const Duration(milliseconds: 300));
      expect(borderPainter(tester)!.progress, inExclusiveRange(0, 1));
      await tester.pumpAndSettle();
      expect(borderPainter(tester)!.progress, 1);
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('reduced motion: a steady border, no looping frames', (tester) async {
      final s = AttentionState();
      await tester.pumpWidget(pane(s, reduced: true));
      s.apply(frame('permission'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      final p = borderPainter(tester)!;
      expect(p.reduced, isTrue);
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets('loops pause while the window is unfocused', (tester) async {
      final s = AttentionState();
      await tester.pumpWidget(pane(s));
      s.apply(frame('working'));
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      expect(tester.binding.hasScheduledFrame, isTrue);
    });
  });

  group('spend ring', () {
    testWidgets('hidden without a cap, drawn with the right colour when there is one', (tester) async {
      final s = AttentionState();
      await tester.pumpWidget(MaterialApp(home: Center(child: SpendRing(attention: s, agentId: 'a', child: const SizedBox(width: 17, height: 17)))));
      expect(find.byType(SpendArc), findsNothing);
      s.apply(frame('working', fraction: 0.9, usd: 4.5));
      await tester.pump();
      await tester.pumpAndSettle();
      final arc = tester.widget<SpendArc>(find.byType(SpendArc));
      expect(arc.fraction, 0.9);
      expect(tester.getSize(find.byType(SpendRing)), const Size(17, 17));
      expect(find.byTooltip(r'$4.50 spent, 90% of the cap'), findsOneWidget);
    });
  });

  group('fleet graph', () {
    final machines = [
      const FleetMachine(id: 'host-a', name: 'host-a', connected: true, local: true, agents: [
        FleetAgent(id: 'a', name: 'planner-1', state: AgentAttention.working, lane: 'planner'),
        FleetAgent(id: 'b', name: 'checker', state: AgentAttention.waiting),
      ]),
      const FleetMachine(id: 'host-b', name: 'host-b', connected: false, agents: [FleetAgent(id: 'c', name: 'drafter', state: AgentAttention.offline)]),
    ];

    test('layout keeps every node inside the canvas', () {
      const size = Size(640, 420);
      final l = FleetLayout.compute(size, machines);
      expect(l.machines.length, 2);
      expect(l.agents.length, 3);
      for (final p in [...l.machines.values, ...l.agents.values]) {
        expect((Offset.zero & size).contains(p), isTrue, reason: '$p');
      }
    });

    testWidgets('animates only while some agent is live, and has a word for every state', (tester) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: FleetGraph(machines: machines))));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.hasScheduledFrame, isTrue);
      expect(find.textContaining('? 1'), findsOneWidget);
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: FleetGraph(machines: [machines[1]]))));
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);
    });
  });

  group('boot splash', () {
    // The splash is off until a logo is chosen; these cover a person who picked the Harness icon.
    setUp(() {
      BootSplash.debugReset();
      brandPrefsStore.value = const BrandPrefs(bootLogo: BootLogo.harness);
    });
    tearDown(() => brandPrefsStore.value = const BrandPrefs());

    testWidgets('stays off when no logo has been chosen', (tester) async {
      brandPrefsStore.value = const BrandPrefs();
      await tester.pumpWidget(const MaterialApp(home: BootSplash(child: Text('app'))));
      expect(find.byKey(BootSplash.overlayKey), findsNothing);
      expect(find.text('app'), findsOneWidget);
    });

    testWidgets('shows once per process, then hands off inside 1.8 s', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BootSplash(child: Text('app'))));
      expect(find.byKey(BootSplash.overlayKey), findsOneWidget);
      expect(find.text('app'), findsOneWidget, reason: 'the app builds underneath, never delayed');
      await tester.pump(const Duration(milliseconds: 1800));
      await tester.pump();
      expect(find.byKey(BootSplash.overlayKey), findsNothing);
      await tester.pumpWidget(const MaterialApp(home: BootSplash(key: ValueKey(2), child: Text('app'))));
      expect(find.byKey(BootSplash.overlayKey), findsNothing, reason: 'a re-opened window is not a cold launch');
    });

    testWidgets('a click skips it', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BootSplash(child: Text('app'))));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(find.byKey(BootSplash.overlayKey));
      // The fade starts on the next frame and takes 180 ms, far short of the full 1.5 s.
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expect(find.byKey(BootSplash.overlayKey), findsNothing);
    });

    testWidgets('a key skips it', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: BootSplash(child: Text('app'))));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      // The fade starts on the next frame and takes 180 ms, far short of the full 1.5 s.
      await tester.pump(const Duration(milliseconds: 16));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expect(find.byKey(BootSplash.overlayKey), findsNothing);
    });

    testWidgets('reduced motion shows a static logo', (tester) async {
      Motion.override = true;
      await tester.pumpWidget(const MaterialApp(home: BootSplash(child: Text('app'))));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.state<BootSplashState>(find.byType(BootSplash)).animated, isFalse);
      await tester.pump(const Duration(milliseconds: 1800));
      await tester.pump();
      expect(find.byKey(BootSplash.overlayKey), findsNothing);
    });
  });
}
