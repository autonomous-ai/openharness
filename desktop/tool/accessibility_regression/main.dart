// Native release regression for flutter/flutter#193410. The runner builds this
// in a disposable app; it never loads Harness state or opens a transport.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness/core/connected_semantics.dart';

const _host = MethodChannel('harness/accessibility_regression');
final _selected = ValueNotifier<int>(0);
final _values = [ValueNotifier<double>(.5), ValueNotifier<double>(.5)];
int _actions = 0;

Widget _slider(int index) => Center(
  child: ValueListenableBuilder<double>(
    valueListenable: _values[index],
    builder: (_, value, _) => Slider(
      value: value,
      onChanged: (value) {
        _values[index].value = value;
      },
    ),
  ),
);

Future<void> _run() async {
  // The unguarded build is an explicit diagnostic mode, not a product setting.
  if (const bool.fromEnvironment('AX_REGRESSION_UNGUARDED')) {
    WidgetsFlutterBinding.ensureInitialized();
  } else {
    HarnessWidgetsBinding();
  }
  await _host.invokeMethod<void>('semantics', true);
  runApp(
    MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            Expanded(
              child: ValueListenableBuilder<int>(
                valueListenable: _selected,
                builder: (_, selected, _) => IndexedStack(
                  index: selected,
                  children: [_slider(0), _slider(1)],
                ),
              ),
            ),
            TextButton(
              onPressed: () => _actions++,
              child: const Text('Native action'),
            ),
          ],
        ),
      ),
    ),
  );
  await Future<void>.delayed(const Duration(milliseconds: 150));
  for (var step = 0; step < 160; step++) {
    if (step % 5 == 4) {
      await _host.invokeMethod<void>('semantics', false);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await _host.invokeMethod<void>('semantics', true);
    }
    _selected.value = step % 2;
    await _host.invokeMethod<void>('resize', step);
    await Future<void>.delayed(const Duration(milliseconds: 35));
    // A rejected stock-engine tree has no actionable controls. Let resizing
    // reach the native reparenting crash instead of stopping on that symptom.
    if (const bool.fromEnvironment('AX_REGRESSION_UNGUARDED')) continue;
    // The native fixture requires one visible slider, then presses a button
    // through AppKit and the real Flutter AX bridge. This engine advertises
    // slider increment but does not implement dispatching it; tap is supported.
    final before = _actions;
    final result = await _host.invokeMethod<bool>('activate');
    for (var attempt = 0; _actions == before && attempt < 100; attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    if (result != true || _actions != before + 1) {
      throw StateError(
        'Native button action failed at step $step: $result, $_actions vs $before',
      );
    }
    // Exercise value changes as well as view switching.
    _values[_selected.value].value = step.isEven ? .25 : .75;
    await Future<void>.delayed(const Duration(milliseconds: 15));
  }
  stdout.writeln(
    'ACCESSIBILITY_REGRESSION_PASS cycles=160 native_actions=$_actions',
  );
  exit(0);
}

void main() {
  runZonedGuarded(() => unawaited(_run()), (Object error, StackTrace stack) {
    stderr.writeln('$error\n$stack');
    exit(1);
  });
}
