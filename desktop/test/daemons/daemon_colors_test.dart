// Colour rules: the status line draws the daemon in its own ink; daemon
// colours appear only on the terminal background, light-safe on a light
// theme; the grue brings its own pitch black; a shiny daemon is brighter.
import 'dart:convert';

import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/daemon_face.dart';
import 'package:harness/daemons/plates.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/daemons/roster.g.dart';
import 'package:harness/daemons/zoo.dart';
import 'package:harness/daemons/zoo_controller.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/widgets/daemon_slot.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

const _light = TerminalTheme(
  cursor: Color(0xff268bd2),
  selection: Color(0x40268bd2),
  foreground: Color(0xff586e75),
  background: Color(0xfffdf6e3),
  black: Color(0xff073642),
  red: Color(0xffdc322f),
  green: Color(0xff859900),
  yellow: Color(0xffb58900),
  blue: Color(0xff268bd2),
  magenta: Color(0xffd33682),
  cyan: Color(0xff2aa198),
  white: Color(0xffeee8d5),
  brightBlack: Color(0xff002b36),
  brightRed: Color(0xffcb4b16),
  brightGreen: Color(0xff586e75),
  brightYellow: Color(0xff657b83),
  brightBlue: Color(0xff839496),
  brightMagenta: Color(0xff6c71c4),
  brightCyan: Color(0xff93a1a1),
  brightWhite: Color(0xfffdf6e3),
  searchHitBackground: Color(0xffb58900),
  searchHitBackgroundCurrent: Color(0xffcb4b16),
  searchHitForeground: Color(0xfffdf6e3),
);

void main() {
  final roster = daemonRoster;
  const dark = darkTerminalTheme;

  test('on the terminal background: legible on dark, 4.5:1 on light', () {
    expect(isDarkTerminal(dark), isTrue);
    expect(isDarkTerminal(_light), isFalse);
    for (final d in roster.daemons) {
      if (d.darkOnly) continue;
      expect(
        contrastRatio(daemonColor(d, dark), dark.background),
        greaterThanOrEqualTo(3),
        reason: d.id,
      );
      for (final shiny in [false, true]) {
        expect(
          contrastRatio(daemonColor(d, _light, shiny: shiny), _light.background),
          greaterThanOrEqualTo(4.5),
          reason: '${d.id} shiny=$shiny',
        );
      }
      // A shiny daemon is told apart by more than the gutter's `*`.
      expect(daemonColor(d, dark, shiny: true), isNot(daemonColor(d, dark)));
      expect(daemonBackdrop(d), isNull);
    }
  });

  test('the grue brings its own pitch black, on every theme', () {
    final grue = roster.byId('grue')!;
    expect(daemonBackdrop(grue), daemonPitch);
    expect(daemonColor(grue, _light), daemonColor(grue, dark));
    expect(
      contrastRatio(daemonColor(grue, _light), daemonPitch),
      greaterThanOrEqualTo(3),
    );
  });

  test("the roster's own light and shiny colours win when it has them", () {
    final raw = jsonDecode(daemonRosterJson) as Map<String, dynamic>;
    final tim = (raw['daemons'] as List).firstWhere((d) => d['id'] == 'tim');
    tim['color'] = {...tim['color'] as Map, 'light': '#2e6b2e'};
    tim['shiny'] = {'hex': '#afff5f'};
    final custom = DaemonRoster.parse(jsonEncode(raw)).byId('tim')!;
    expect(daemonColor(custom, _light), const Color(0xff2e6b2e));
    expect(daemonColor(custom, dark, shiny: true), const Color(0xffafff5f));
    // Every daemon in the roster now has its own shiny colour: every shiny
    // in drop init is gold, tim's too; the grue a deep violet on its black.
    for (final d in daemonRoster.daemons) {
      expect(d.shinyColor, isNotNull, reason: d.id);
    }
    expect(daemonRoster.byId('tim')!.shinyColor, const Color(0xffd7af00));
    expect(
      daemonColor(daemonRoster.byId('tim')!, dark, shiny: true),
      const Color(0xffd7af00),
    );
    expect(daemonRoster.byId('tmux')!.shinyColor, const Color(0xff00ffaf));
  });

  test('a plate is coloured by the plate rule on a dark theme, and kept '
      'legible on a light one', () {
    for (final d in roster.daemons) {
      if (!d.plate) {
        expect(daemonPlateInk(roster, d, dark), isNull, reason: d.id);
        continue;
      }
      for (final shiny in [false, true]) {
        final gradient = plateGradient(d, shiny: shiny)!;
        final onDark = daemonPlateInk(roster, d, dark, shiny: shiny)!;
        expect(onDark.gradient.top, gradient.top);
        expect(onDark.gradient.bottom, gradient.bottom);
        expect(onDark.background, dark.background);
        expect(onDark.burn, const Color(0xffffffff));
        expect(onDark.glow, gradient.bottom);
        final onLight = daemonPlateInk(roster, d, _light, shiny: shiny)!;
        for (final stop in [onLight.gradient.top, onLight.gradient.bottom]) {
          expect(
            contrastRatio(stop, _light.background),
            greaterThanOrEqualTo(4.5),
            reason: '${d.id} shiny=$shiny',
          );
        }
        // `@` burns toward the far end: black on a light theme.
        expect(onLight.burn, const Color(0xff000000));
        expect(
          onLight.glyph(3, 0, '@')!.computeLuminance(),
          lessThan(onLight.row(3, 0).computeLuminance() + 1e-9),
        );
      }
    }
    // A card or panel ground is what faint glyphs mix from.
    final tim = roster.byId('tim')!;
    const ground = Color(0xff202020);
    expect(
      daemonPlateInk(roster, tim, dark, background: ground)!.glyph(5, 2, '.'),
      plateColor(roster, tim, 5, 2, '.', background: ground),
    );
  });

  Future<DaemonFace> face(WidgetTester tester, String id) async {
    final storage = _Memory()
      ..values[ZooController.localZooKey] = jsonEncode({
        'zoo': Zoo(
          daemons: [ZooDaemon(id: id, hatched: '', egg: 'first')],
          pair: id,
        ).toJson(),
        'seeded': true,
      });
    final zoo = ZooController(storage: storage);
    final face = DaemonFace(zoo);
    addTearDown(() {
      face.dispose();
      zoo.dispose();
    });
    zoo.bind('guest');
    await tester.pump();
    return face;
  }

  testWidgets('the slot draws in the status line ink; the grue on a light '
      'theme on a black patch', (tester) async {
    for (final d in roster.daemons.where((d) => !d.darkOnly)) {
      final f = await face(tester, d.id);
      for (final theme in [dark, _light]) {
        expect(daemonSlotInk(f, theme), theme.foreground, reason: d.id);
        expect(daemonSlotPatch(f, theme), isNull);
      }
    }
    final grue = await face(tester, 'grue');
    expect(daemonSlotPatch(grue, dark), isNull);
    expect(daemonSlotInk(grue, dark), dark.foreground);
    expect(daemonSlotPatch(grue, _light), daemonPitch);
    expect(daemonSlotInk(grue, _light), daemonColor(grue.def!, _light));
  });
}
