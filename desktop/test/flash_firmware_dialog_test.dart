import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/flash/flasher.dart';
import 'package:harness/widgets/flash_firmware_dialog.dart';

class _DialogFlasher extends Flasher {
  _DialogFlasher({required super.windows});
  final stopped = Completer<FlashResult>();

  @override
  Future<FlashProbe> probe() async =>
      const FlashProbe(ports: ['COM3'], log: []);

  @override
  Future<FlashResult> flash({String? port, void Function(FlashLine)? onLine}) {
    onLine?.call(const FlashLine('>> writing firmware', FlashLineKind.step));
    return stopped.future;
  }

  @override
  void cancel() =>
      stopped.complete(const FlashResult(exitCode: 130, cancelled: true));
}

void main() {
  for (final windows in [true, false]) {
    testWidgets(
      'output identifies the ${windows ? 'Windows' : 'Unix'} script and Stop avoids an unverified restart claim',
      (tester) async {
        final flasher = _DialogFlasher(windows: windows);
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => TextButton(
                onPressed: () => unawaited(
                  showFlashFirmwareDialog(context, flasher: flasher),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('flash-start-button')));
        await tester.pump();
        expect(
          find.text(windows ? 'flash-circle.ps1' : 'flash-circle.sh'),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const Key('flash-stop-button')));
        await tester.pumpAndSettle();
        expect(find.text('Stopped.'), findsOneWidget);
        expect(
          find.textContaining('Harness has been started again.'),
          findsNothing,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
