// Wire fixtures are generated from desktop's real layout catalogue and consumed
// by hn's independent cell renderer. Regenerate only for an intentional change:
// UPDATE_SHARED_LAYOUT_FIXTURES=1 flutter test test/shared_pane_layout_test.dart
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_preset.dart';

void main() {
  test('desktop and hn share the complete layout catalogue and slot order', () {
    final cases = <Map<String, Object>>[];
    for (var count = 2; count <= 9; count++) {
      for (final preset in PanePreset.forCount(count)) {
        cases.add({
          'count': count,
          'preset': preset.id,
          'label': preset.label,
          'offered': true,
          'tiles': PaneArrangement(preset.tilesFor(count)).toJson(),
        });
      }
      for (final preset in [
        PanePreset.defaultFor(count)!,
        PanePreset.cols2,
        PanePreset.cols3,
        PanePreset.cols4,
        PanePreset.cols5,
      ]) {
        cases.add({
          'count': count,
          'preset': preset.id,
          'offered': false,
          'tiles': PaneArrangement(preset.tilesFor(count))
              .fillRowEnds()
              .toJson(),
        });
      }
    }
    final fixture = File('../tests/fixtures/shared-pane-layouts.json');
    if (Platform.environment['UPDATE_SHARED_LAYOUT_FIXTURES'] == '1') {
      fixture.writeAsStringSync('[\n${cases.map(jsonEncode).join(',\n')}\n]\n');
    }
    expect(jsonDecode(fixture.readAsStringSync()), cases);
  });

  test(
    'legacy empty row ends fill without changing other cuts or pane order',
    () {
      final old = PaneArrangement(PanePreset.cols3.tilesFor(5));
      final next = old.fillRowEnds();
      expect(next.tiles.take(4), old.tiles.take(4));
      expect(next.tiles.last, const Rect.fromLTRB(1 / 3, .5, 1, 1));
      expect(identical(next.fillRowEnds(), next), isTrue);
      for (var count = 2; count <= 9; count++) {
        for (final preset in PanePreset.forCount(count)) {
          final layout = PaneArrangement(preset.tilesFor(count));
          expect(identical(layout.fillRowEnds(), layout), isTrue);
        }
      }
    },
  );
}
