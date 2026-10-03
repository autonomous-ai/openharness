import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:harness/shared/widgets/app_dialog.dart';
import 'package:harness/widgets/clone_repository_dialog.dart';

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work';
}

class _Clone extends RepositoryClone {
  final pending = Completer<String>();
  bool cancelled = false;
  int runs = 0, cancellations = 0;
  @override
  Future<String> run(GitHubRepository repository, String parent) {
    runs++;
    return pending.future;
  }

  @override
  void cancel() {
    cancelled = true;
    cancellations++;
  }
}

Future<void> _openClone(
  WidgetTester tester, {
  required _Clone clone,
  required void Function(String?) onResult,
  double textScale = 1,
}) async {
  final original = FileSelectorPlatform.instance;
  FileSelectorPlatform.instance = _Folders();
  addTearDown(() => FileSelectorPlatform.instance = original);
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            onResult(
              await showAppDialog<String>(
                context: context,
                builder: (_) => CloneRepositoryDialog(createClone: () => clone),
              ),
            );
          },
          child: const Text('Open'),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
  await tester.enterText(
    find.byKey(const ValueKey('clone-repository-url')),
    'owner/project',
  );
  await tester.tap(find.text('Choose folder…'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(FilledButton, 'Clone repository'));
  await tester.pump();
}

void main() {
  testWidgets('clone URL takes keyboard focus and owns composing Escape', (
    tester,
  ) async {
    var closed = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              await showCloneRepositoryDialog(context);
              closed = true;
            },
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    final input = find.byKey(const ValueKey('clone-repository-url'));
    expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
    const value = TextEditingValue(
      text: 'owner/repository',
      selection: TextSelection.collapsed(offset: 16),
      composing: TextRange(start: 6, end: 16),
    );
    tester.testTextInput.updateEditingValue(value);
    await tester.pump();
    expect(tester.widget<TextField>(input).controller!.value, value);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(closed, isFalse);
    expect(tester.widget<TextField>(input).controller!.value, value);
    expect(
      tester.widget<EditableText>(find.byType(EditableText)).focusNode.hasFocus,
      isTrue,
    );
    tester.testTextInput.updateEditingValue(
      value.copyWith(composing: TextRange.empty),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(closed, isTrue);
    expect(find.byType(CloneRepositoryDialog), findsNothing);
    closed = false;
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    tester.testTextInput.updateEditingValue(value);
    await tester.pump();
    expect(tester.widget<TextField>(input).controller!.value, value);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(closed, isTrue);
    expect(find.byType(CloneRepositoryDialog), findsNothing);
  });

  testWidgets('clone failure is visible with large text and keyboard retry', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(880, 560);
    addTearDown(tester.view.reset);
    final clone = _Clone();
    await _openClone(tester, clone: clone, onResult: (_) {}, textScale: 2);
    const message =
        'Could not access this repository. Check the URL and your GitHub access on this computer.';
    clone.pending.completeError(const RepositoryCloneException(message));
    await tester.pumpAndSettle();
    expect(find.text(message).hitTestable(), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Clone repository').hitTestable(),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('Cancel does not return a clone that finishes while stopping', (
    tester,
  ) async {
    final clone = _Clone();
    final results = <String?>[];
    await _openClone(tester, clone: clone, onResult: results.add);
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    expect(clone.cancelled, isTrue);
    expect(find.text('Cancelling…'), findsOneWidget);
    expect(results, isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(clone.cancellations, 1);
    // Git may have finished its rename when Cancel arrived. A completed folder
    // can be kept on disk without selecting it or advancing the parent flow.
    clone.pending.complete('/work/project');
    await tester.pumpAndSettle();
    expect(results, [null]);
    expect(find.byType(CloneRepositoryDialog), findsNothing);
  });

  testWidgets('Escape cancels a clone and keeps its cleanup visible', (
    tester,
  ) async {
    final clone = _Clone();
    final results = <String?>[];
    await _openClone(tester, clone: clone, onResult: results.add);
    await tester.tapAt(const Offset(4, 4));
    await tester.pump();
    expect(clone.cancelled, isFalse);
    expect(results, isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(clone.cancelled, isTrue);
    expect(find.text('Cancelling…'), findsOneWidget);
    expect(results, isEmpty);
    clone.pending.completeError(
      const RepositoryCloneException('Clone cancelled.'),
    );
    await tester.pumpAndSettle();
    expect(results, [null]);
    expect(find.byType(CloneRepositoryDialog), findsNothing);
  });

  testWidgets(
    'clone failure preserves inputs; retry returns the new working folder',
    (tester) async {
      final original = FileSelectorPlatform.instance;
      FileSelectorPlatform.instance = _Folders();
      addTearDown(() => FileSelectorPlatform.instance = original);
      var clone = _Clone();
      String? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                result = await showDialog<String>(
                  context: context,
                  builder: (_) =>
                      CloneRepositoryDialog(createClone: () => clone),
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      final submit = find.widgetWithText(FilledButton, 'Clone repository');
      final input = find.byKey(const ValueKey('clone-repository-url'));
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tester.enterText(input, 'owner/project');
      await tester.tap(find.text('Choose folder…'));
      await tester.pumpAndSettle();
      await tester.tap(submit);
      await tester.pump();
      expect(tester.widget<TextField>(input).readOnly, isTrue);
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      clone.pending.completeError(
        const RepositoryCloneException('Please check your GitHub access.'),
      );
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(input).controller!.text, 'owner/project');
      expect(find.text('/work'), findsOneWidget);
      expect(find.text('Please check your GitHub access.'), findsOneWidget);
      clone = _Clone();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(clone.runs, 1);
      clone.pending.complete('/work/project');
      await tester.pumpAndSettle();
      expect(result, '/work/project');
      expect(input, findsNothing);
    },
  );
}
