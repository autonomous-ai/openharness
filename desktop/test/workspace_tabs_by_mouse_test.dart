import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/workspace_tab_scroller.dart';

void main() {
  test('Windows reaches tabs that do not fit by arrows and the wheel', () {
    expect(scrollsTabsByMouse(null, windows: true), isTrue);
  });

  test('a host with its own tab strip keeps it', () {
    expect(scrollsTabsByMouse(null, windows: false), isFalse);
  });
}
