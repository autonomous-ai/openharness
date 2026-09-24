import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/desktop_window.dart';

/// A native folder chooser is a SHEET on this window, and the app has to know
/// one is up: [revealWindow] must not re-order the window under it, and the
/// dial's task palette must not open behind it.
void main() {
  test('starts closed', () {
    expect(nativePickerOpen, isFalse);
  });

  test('held for as long as the chooser is up, and no longer', () async {
    final answer = Completer<String?>();
    final picked = whileNativePicker(() => answer.future);
    expect(nativePickerOpen, isTrue);
    answer.complete('/tmp/somewhere');
    expect(await picked, '/tmp/somewhere');
    expect(nativePickerOpen, isFalse);
  });

  test('released when the chooser throws', () async {
    await expectLater(
      whileNativePicker<String?>(() async => throw StateError('no window')),
      throwsStateError,
    );
    expect(nativePickerOpen, isFalse);
  });

  // The dialog holding a chooser can be disposed while it is open — its own
  // `mounted` guard then skips the flag reset. The count is not allowed to
  // leak that way, and two panes may each be browsing at once.
  test('counts, so one chooser closing does not clear another', () async {
    final first = Completer<String?>();
    final second = Completer<String?>();
    final a = whileNativePicker(() => first.future);
    final b = whileNativePicker(() => second.future);
    expect(nativePickerOpen, isTrue);
    first.complete(null);
    await a;
    expect(nativePickerOpen, isTrue, reason: 'the second one is still up');
    second.complete(null);
    await b;
    expect(nativePickerOpen, isFalse);
  });

  test('revealWindow is a no-op while a chooser is up', () async {
    final answer = Completer<String?>();
    final picked = whileNativePicker(() => answer.future);
    // On a headless test host `hasManagedWindow` is true on macOS/Linux and the
    // plugin throws; the point is that this returns without raising anything.
    await revealWindow();
    answer.complete(null);
    await picked;
  });
}
