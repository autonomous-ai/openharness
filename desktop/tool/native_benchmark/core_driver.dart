// Framework text/key dispatch through the production parser and Release renderer.
// No OS input, network, model, or display-presentation latency is claimed here.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/swarm_search_input.dart';
import 'package:harness/widgets/terminal_find_bar.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:xterm/src/ui/custom_text_edit.dart';
import 'package:xterm/xterm.dart';

import 'flutter_driver.dart';

const _escape = (LogicalKeyboardKey.escape, PhysicalKeyboardKey.escape);
const _enter = (LogicalKeyboardKey.enter, PhysicalKeyboardKey.enter);

void _check(bool ok, String message) {
  if (!ok) throw StateError(message);
}

TextEditingValue _editingValue() {
  final terminal = benchmarkFind(
    (w) => w is CustomTextEdit && w.focusNode.hasFocus,
  );
  if (terminal != null) {
    final state = (terminal as StatefulElement).state as CustomTextEditState;
    _check(
      state.hasInputConnection,
      'Focused terminal has no text input connection',
    );
    return state.currentTextEditingValue!;
  }
  final field = benchmarkFind((w) => w is EditableText && w.focusNode.hasFocus);
  if (field != null) return (field.widget as EditableText).controller.value;
  throw StateError(
    'No focused text input: ${FocusManager.instance.primaryFocus}',
  );
}

void _insert(String text, {bool replace = false}) {
  final value = _editingValue();
  final selection = replace
      ? TextSelection(baseOffset: 0, extentOffset: value.text.length)
      : value.selection;
  _check(selection.isValid, 'Text input has no valid selection');
  final updated = value.text.replaceRange(selection.start, selection.end, text);
  TextInput.updateEditingValue(
    TextEditingValue(
      text: updated,
      selection: TextSelection.collapsed(offset: selection.start + text.length),
    ),
  );
}

Future<void> runCoreBenchmark(
  AppNotifier app,
  String output,
  Map<String, Object?> metadata,
  Map<int, ui.FrameTiming> timings, {
  required int samples,
  required List<(String, String)> inputs,
  required Future<void> Function(bool) setOutput,
  required Map<String, int> Function() outputCounters,
}) async {
  final rows = <Map<String, Object?>>[];
  final phases = <Map<String, Object?>>[];
  final fixtureCount = app.allPanes.length;
  final firstTab = app.activeSwarmId;
  final startedAt = DateTime.now().toUtc().toIso8601String();
  const host = MethodChannel('harness/isolated_benchmark');
  var initialWindow = await host.invokeMapMethod<String, Object?>(
    'captureState',
  );
  // Normal app launch can initially be backgrounded. Let the operator raise
  // this fixture once; never reclaim focus during the measured series.
  for (
    var attempt = 0;
    attempt < 120 &&
        (initialWindow?['key'] != true || initialWindow?['active'] != true);
    attempt++
  ) {
    await Future<void>.delayed(const Duration(milliseconds: 250));
    initialWindow = await host.invokeMapMethod<String, Object?>('captureState');
  }
  // Warm every retained renderer once, not just the first workspace.
  for (final tab in app.swarms.toList()) {
    app.selectSwarm(tab.id, attachPending: false);
    await benchmarkFrame();
  }
  app.selectSwarm(firstTab, attachPending: false);
  await benchmarkFrame();

  Future<void> terminalInput() async {
    final before = inputs.length;
    final expected = app.focusedPane?.session?.agentId;
    _check(expected != null, 'No destination terminal');
    _insert('x');
    await benchmarkFrame();
    _check(
      inputs.length == before + 1 && inputs.last == (expected, 'x'),
      'Input was lost, duplicated, or sent to the wrong terminal',
    );
  }

  Future<void> measure(
    String operation,
    String load,
    int sample,
    Future<void> Function() action,
  ) async {
    final previousFrame = await benchmarkFrame();
    final delay = (sample + 5) * 11003 % 20000;
    await Future<void>.delayed(Duration(microseconds: delay));
    final began = DateTime.now().microsecondsSinceEpoch;
    await action();
    // action has awaited the frame that validates its state. Capture that exact
    // frame, not a later unrelated redraw, and join the renderer's timing below.
    rows.add({
      'operation': operation,
      'load': load,
      'phase': sample < 0 ? 'warmup' : 'measured',
      'startedWallMicros': began,
      'previousFrame': previousFrame,
      'readyFrame': ui.PlatformDispatcher.instance.frameData.frameNumber,
      'phaseDelayMicros': delay,
    });
  }

  Future<void> dismissNew() async {
    final element = benchmarkFind((w) => w is NewHarnessBox);
    if (element == null) return;
    final controller = (element.widget as NewHarnessBox).controller;
    for (
      var step = 0;
      step < 8 && controller.field != NewHarnessField.launch;
      step++
    ) {
      benchmarkKey(_escape, command: false);
      await benchmarkFrame();
    }
    benchmarkKey(_escape, command: false);
    await benchmarkFrame();
    _check(
      benchmarkFind((w) => w is NewHarnessBox) == null,
      'New harness did not close',
    );
  }

  try {
    _check(
      initialWindow?['key'] == true && initialWindow?['active'] == true,
      'Core measurement requires the foreground benchmark window: $initialWindow',
    );
    for (final load in ['idle', 'all_terminals_20hz']) {
      await setOutput(load != 'idle');
      final phaseBegan = DateTime.now().microsecondsSinceEpoch;
      final countersBefore = outputCounters();
      for (final operation in [
        'typing_echo',
        'cmd_n',
        'cmd_o',
        'picker_query',
        'picker_accept_input',
        'cmd_t',
        if (fixtureCount > 4) 'tab_input',
        if (fixtureCount > 1) ...['focus_input', 'zoom'],
        'find_query',
        'scroll_page',
      ]) {
        for (var sample = -5; sample < samples; sample++) {
          final originalTab = app.activeSwarmId;
          final tabsBefore = app.swarms.length;
          SwarmSearchInput? picker;
          if (operation == 'picker_query' ||
              operation == 'picker_accept_input') {
            benchmarkKey((LogicalKeyboardKey.keyO, PhysicalKeyboardKey.keyO));
            await benchmarkFrame();
            picker =
                benchmarkFind((w) => w is SwarmSearchInput && w.search != null)
                        ?.widget
                    as SwarmSearchInput?;
            _check(
              picker != null && picker.focusNode.hasFocus,
              'Picker did not take input focus',
            );
            if (operation == 'picker_accept_input') {
              // Picking an agent from a different workspace can add a tile.
              // Focus another retained tile here so the declared fixture size
              // and visible count remain constant through the entire series.
              final target = app.panes
                  .firstWhere(
                    (pane) => pane.id != app.focusedPaneId,
                    orElse: () => app.panes.first,
                  )
                  .agentId!;
              _insert('Fixture agent ${target.split('-').last}', replace: true);
              await benchmarkFrame();
              _check(
                picker!.search!.selected?.agentId == target,
                'Picker selected an unexpected terminal',
              );
            }
          } else if (operation == 'find_query') {
            benchmarkKey((LogicalKeyboardKey.keyF, PhysicalKeyboardKey.keyF));
            await benchmarkFrame();
            _insert('', replace: true);
            await benchmarkFrame();
          } else if (operation == 'focus_input') {
            app.focusPaneByIndex(0);
            await benchmarkFrame();
          }

          await measure(operation, load, sample, () async {
            switch (operation) {
              case 'typing_echo':
                await terminalInput();
              case 'cmd_n':
                benchmarkKey((
                  LogicalKeyboardKey.keyN,
                  PhysicalKeyboardKey.keyN,
                ));
                await benchmarkFrame();
                _check(
                  benchmarkFind((w) => w is NewHarnessBox) != null,
                  'Cmd+N did not open',
                );
                _editingValue(); // The visible surface must also own editable focus.
              case 'cmd_o':
                benchmarkKey((
                  LogicalKeyboardKey.keyO,
                  PhysicalKeyboardKey.keyO,
                ));
                await benchmarkFrame();
                final input =
                    benchmarkFind(
                          (w) => w is SwarmSearchInput && w.search != null,
                        )?.widget
                        as SwarmSearchInput?;
                _check(
                  input != null && input.focusNode.hasFocus,
                  'Cmd+O is not input-ready',
                );
              case 'picker_query':
                _insert('Fixture agent 0', replace: true);
                await benchmarkFrame();
                _check(
                  picker!.search!.query == 'Fixture agent 0' &&
                      picker.search!.selected?.agentId == 'fixture-0',
                  'Query did not update results',
                );
              case 'picker_accept_input':
                final expected = picker!.search!.selected!.agentId;
                benchmarkKey(_enter, command: false);
                await benchmarkFrame();
                _check(
                  app.focusedPane?.agentId == expected,
                  'Picker did not focus the selected terminal',
                );
                await terminalInput();
              case 'cmd_t':
                benchmarkKey((
                  LogicalKeyboardKey.keyT,
                  PhysicalKeyboardKey.keyT,
                ));
                await benchmarkFrame();
                _check(
                  app.activeSwarmId != originalTab &&
                      app.swarms.length == tabsBefore + 1 &&
                      app.panes.isEmpty &&
                      benchmarkFind((w) => w is WorkspaceWelcome) != null,
                  'Cmd+T did not create its welcome tab',
                );
              case 'tab_input':
                benchmarkKey((
                  LogicalKeyboardKey.bracketRight,
                  PhysicalKeyboardKey.bracketRight,
                ), shift: true);
                await benchmarkFrame();
                _check(app.activeSwarmId != originalTab, 'Tab did not change');
                await terminalInput();
              case 'focus_input':
                benchmarkKey((
                  LogicalKeyboardKey.arrowRight,
                  PhysicalKeyboardKey.arrowRight,
                ));
                await benchmarkFrame();
                _check(
                  app.focusedPaneId == app.panes[1].id,
                  'Pane focus did not move',
                );
                await terminalInput();
              case 'zoom':
                benchmarkKey(_enter);
                await benchmarkFrame();
                _check(app.zoomedPaneId != null, 'Pane did not zoom');
              case 'find_query':
                _insert('project context', replace: true);
                // The text callback owns query changes; await the real index's
                // completion before claiming that the result frame is ready.
                final find =
                    benchmarkFind(
                          (w) => w is TerminalFindBar && w.search != null,
                        )?.widget
                        as TerminalFindBar?;
                _check(
                  find?.search?.query == 'project context',
                  'Find query did not reach its index',
                );
                await find!.search!.settled.timeout(const Duration(seconds: 5));
                await benchmarkFrame();
                _check(
                  find.search!.count > 0,
                  'Find did not return a real match',
                );
              case 'scroll_page':
                final view =
                    benchmarkFind(
                          (w) =>
                              w is TerminalView &&
                              w.focusNode?.hasFocus == true,
                        )?.widget
                        as TerminalView?;
                final controller = view?.scrollController;
                _check(
                  controller != null && controller.hasClients,
                  'Focused terminal has no scroll position',
                );
                final position = controller!.position;
                final target = (position.pixels - position.viewportDimension)
                    .clamp(position.minScrollExtent, position.maxScrollExtent);
                _check(target != position.pixels, 'Scroll did not move');
                controller.jumpTo(target);
                await benchmarkFrame();
                _check(
                  (controller.offset - target).abs() < 1,
                  'Scroll destination is wrong',
                );
            }
          });

          if (operation == 'cmd_n') {
            await dismissNew();
          } else if ([
            'cmd_o',
            'picker_query',
            'find_query',
          ].contains(operation)) {
            benchmarkKey(_escape, command: false);
            await benchmarkFrame();
          } else if (operation == 'cmd_t') {
            benchmarkKey((LogicalKeyboardKey.keyW, PhysicalKeyboardKey.keyW));
            await benchmarkFrame();
            _check(
              app.swarms.length == tabsBefore,
              'Benchmark tab was not closed',
            );
            app.selectSwarm(originalTab, attachPending: false);
            await benchmarkFrame();
          } else if (operation == 'zoom') {
            benchmarkKey(_enter);
            await benchmarkFrame();
            _check(app.zoomedPaneId == null, 'Zoom did not restore');
          } else if (operation == 'scroll_page') {
            final view =
                benchmarkFind(
                      (w) => w is TerminalView && w.focusNode?.hasFocus == true,
                    )!.widget
                    as TerminalView;
            view.scrollController!.jumpTo(
              view.scrollController!.position.maxScrollExtent,
            );
            await benchmarkFrame();
          }
          _check(
            app.allPanes.length == fixtureCount &&
                app.panes.length == (fixtureCount < 4 ? fixtureCount : 4),
            'Operation changed the declared terminal or visible-pane count',
          );
        }
        // A progress artifact distinguishes this invocation from any stale file.
        await File('$output.progress').writeAsString(
          jsonEncode({
            'startedAt': startedAt,
            'load': load,
            'completed': operation,
            'observations': rows.length,
          }),
        );
      }
      await setOutput(false);
      final after = outputCounters();
      phases.add({
        'load': load,
        'durationMicros': DateTime.now().microsecondsSinceEpoch - phaseBegan,
        for (final key in after.keys) key: after[key]! - countersBefore[key]!,
      });
    }
    for (
      var attempt = 0;
      attempt < 30 && rows.any((r) => !timings.containsKey(r['readyFrame']));
      attempt++
    ) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await benchmarkFrame();
    }
    for (final row in rows) {
      final timing = timings[row['readyFrame']];
      _check(timing != null, 'Missing exact renderer frame');
      row['readyRasterMicros'] =
          timing!.timestampInMicroseconds(ui.FramePhase.rasterFinishWallTime) -
          (row['startedWallMicros'] as int);
      row['buildMicros'] = timing.buildDuration.inMicroseconds;
      row['rasterMicros'] = timing.rasterDuration.inMicroseconds;
      _check((row['readyRasterMicros'] as int) >= 0, 'Invalid frame timestamp');
    }
    final finalWindow = await host.invokeMapMethod<String, Object?>(
      'captureState',
    );
    _check(
      finalWindow?['focusLosses'] == initialWindow?['focusLosses'] &&
          finalWindow?['key'] == true &&
          finalWindow?['active'] == true,
      'Benchmark lost foreground focus; preserve this run but do not accept timings',
    );
    metadata['initialWindow'] = initialWindow;
    metadata['finalWindow'] = finalWindow;
    await File(output).writeAsString(
      const JsonEncoder.withIndent('  ').convert({
        'success': true,
        'kind': 'release_core_framework_dispatch_to_raster',
        'startedAt': startedAt,
        'finishedAt': DateTime.now().toUtc().toIso8601String(),
        'metadata': metadata,
        'terminals': fixtureCount,
        'visible': fixtureCount < 4 ? fixtureCount : 4,
        'initialScrollbackRows': 1000,
        'samplesPerOperationPerLoad': samples,
        'warmups': 5,
        'inputCommitsVerified': inputs.length,
        'phases': phases,
        'summaries': [
          for (final load in ['idle', 'all_terminals_20hz'])
            for (final operation in rows.map((r) => r['operation']).toSet())
              {
                'load': load,
                'operation': operation,
                for (final metric in [
                  'readyRasterMicros',
                  'buildMicros',
                  'rasterMicros',
                ])
                  metric: benchmarkDistribution([
                    for (final row in rows)
                      if (row['load'] == load &&
                          row['operation'] == operation &&
                          row['phase'] == 'measured')
                        row[metric] as int,
                  ]),
              },
        ],
        'observations': rows,
      }),
    );
  } catch (error, stack) {
    await File(output).writeAsString(
      jsonEncode({
        'success': false,
        'startedAt': startedAt,
        'error': '$error',
        'stack': '$stack',
        'observations': rows,
      }),
    );
    rethrow;
  } finally {
    await setOutput(false);
  }
}
