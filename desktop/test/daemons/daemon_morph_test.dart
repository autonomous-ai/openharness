// A level-up in the reveal: the portrait turns into its new version in three
// dithered frames, then holds, on one canvas; and the changelog line.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/daemon_lines.dart';
import 'package:harness/daemons/render.dart';
import 'package:harness/daemons/roster.dart';
import 'package:harness/widgets/daemon_hatch.dart';

void main() {
  final roster = daemonRoster;
  final tim = roster.byId('tim')!;
  List<String> portrait(String v) =>
      renderPortrait(roster, tim, v, DaemonMood.idle, motion: false);

  test(
    'three frames between two versions, on one canvas, then the new one',
    () {
      final from = portrait('0.1'), to = portrait('1.0');
      final frames = [for (var s = 0; s <= 4; s++) morphPortrait(from, to, s)];
      final rows = frames.first.length;
      expect(rows, from.length > to.length ? from.length : to.length);
      for (final frame in frames) {
        expect(frame, hasLength(rows), reason: 'one canvas: nothing jumps');
      }
      String flat(List<String> art) => art.map((r) => r.trimRight()).join('\n');
      // Step 4 is the new version, bottom-aligned on the canvas.
      expect(
        flat(frames[4].sublist(rows - to.length)).replaceAll(' ', ''),
        flat(to).replaceAll(' ', ''),
      );
      // Each step turns more cells, and the middle ones are neither.
      int changed(List<String> a, List<String> b) {
        var n = 0;
        for (var r = 0; r < a.length; r++) {
          final x = a[r].padRight(80), y = b[r].padRight(80);
          for (var c = 0; c < 80; c++) {
            if (x[c] != y[c]) n++;
          }
        }
        return n;
      }

      final toward = [for (final f in frames) changed(f, frames[4])];
      expect(toward.last, 0);
      expect(toward[1], greaterThan(toward[2]));
      expect(toward[2], greaterThan(toward[3]));
      expect(toward[3], greaterThan(0));
      // The same every time.
      expect(morphPortrait(from, to, 2), morphPortrait(from, to, 2));
    },
  );

  test('the changelog line: tim has the lookbook\'s; others say the bond', () {
    expect(
      daemonChangelog(tim, '2.0', bond: 4, xp: 600),
      'tim 2.0: eight arms, one per pane; in-jokes from your logbook',
    );
    expect(
      daemonChangelog(roster.byId('vim')!, '1.0', bond: 2, xp: 150),
      'vim 1.0: bond level 2, 150 xp.',
    );
  });

  test('autonomy words for the badge', () {
    expect(daemonAutonomyLabel('act-on-key'), 'act on key');
    expect(daemonAutonomyAboveSuggest('suggest'), isFalse);
    expect(daemonAutonomyAboveSuggest('act-within-rules'), isTrue);
    expect(daemonAutonomyAboveSuggest(null), isFalse);
  });
}
