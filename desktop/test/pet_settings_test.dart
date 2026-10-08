import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/devices_controller.dart';
import 'package:harness/devices/devices_screen.dart';
import 'package:harness/devices/loose_sheet.dart' show petRows;
import 'package:harness/devices/pet_editor.dart' show petStateLabels;
import 'package:harness/devices/pet_settings.dart';
import 'package:harness/devices/pet_source.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/dial_status.dart';

import 'devices_controller_test.dart' show deviceStatus, report;
import 'support/real_fonts.dart';

/// A 1 x 1 transparent PNG, as the daemon sends it: a data URL.
final _png =
    'data:image/png;base64,${base64Encode(base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))}';

Map<String, dynamic> _preview() => {
  'ok': true,
  'id': 'boba',
  'bytes': 412 * 1024,
  'colours': 87,
  'warnings': ['Soft edges will look jagged on the dial'],
  'frames': {
    'small': [_png, _png],
    'working': [_png],
    'listening': [_png],
    'sending': [_png],
    'asking': [_png, _png, _png],
  },
  'stepMs': {
    'small': 200,
    'working': 120,
    'listening': 160,
    'sending': 160,
    'asking': 90,
  },
};

/// A preview of a sheet with [rows] non-empty, each with a strip.
Map<String, dynamic> sheetPreview(
  String id,
  List<String> rows, {
  Map<String, String>? mapping,
  int frames = 4,
}) => _preview()
  ..['id'] = id
  ..['rows'] =
      mapping ??
      {
        'rest': 'idle',
        'working': 'running',
        'listening': 'review',
        'sending': 'waving',
        'asking': 'waiting',
      }
  ..['sheetRows'] = [
    for (final row in rows) {'row': row, 'frames': frames, 'strip': _png},
  ];

class _Daemon {
  Map<String, dynamic> mapping = {'all': null, 'engines': <String, String>{}};
  bool supported = true;
  Map<String, dynamic>? sending;
  List<String> held = [];
  Map<String, String> errors = {};
  Map<String, dynamic>? pets;
  Map<String, dynamic>? statusError;

  /// Called on each pet_status, to move the dial along.
  void Function()? onStatus;
  Map<String, dynamic> previewReply = _preview();

  /// Answers pet_preview in place of [previewReply] when set.
  Future<Map<String, dynamic>> Function(Map<String, Object?> payload)?
  onPreview;
  Map<String, dynamic>? applyReply;
  final requests = <String>[];
  final payloads = <String, List<Map<String, Object?>>>{};

  Future<Map<String, dynamic>> call(
    String machine,
    String type,
    Map<String, Object?> payload,
  ) async {
    requests.add(type);
    (payloads[type] ??= []).add(payload);
    switch (type) {
      case 'pet_status':
        onStatus?.call();
        if (statusError != null) return statusError!;
        return {
          'mapping': mapping,
          'pets': ?pets,
          'dial': {
            'supported': supported,
            'held': held,
            'sending': sending,
            if (errors.isNotEmpty) 'errors': errors,
          },
        };
      case 'pet_preview':
        return onPreview?.call(payload) ?? previewReply;
      case 'pet_apply':
        if (applyReply != null) return applyReply!;
        final target = payload['target'] as String;
        mapping = target == 'all'
            ? {...mapping, 'all': payload['id']}
            : {
                ...mapping,
                'engines': {
                  ...(mapping['engines'] as Map),
                  target: payload['id'],
                },
              };
        return {'ok': true, 'mapping': mapping};
      default:
        final target = payload['target'] as String;
        mapping = target == 'all'
            ? {...mapping, 'all': null}
            : {
                ...mapping,
                'engines': {...(mapping['engines'] as Map)}..remove(target),
              };
        return {'ok': true, 'mapping': mapping};
    }
  }
}

void main() {
  var daemon = _Daemon();
  setUp(() => daemon = _Daemon());

  late DevicesController controller;
  late DialState dial;

  Future<void> build(
    WidgetTester tester, {
    bool attached = true,
    Future<String?> Function()? pick,
    Future<PetSource> Function(String path)? resolve,
    Future<PetSheet?> Function(String path)? loadSheet,
    Size size = const Size(1200, 2400),
  }) async {
    dial = DialState();
    controller = DevicesController(
      dial: dial,
      accountId: 'pets',
      sendSettings: (_, _) async => true,
      petRequest: daemon.call,
    );
    await controller.load();
    report(dial, [deviceStatus('one', attached: attached)]);
    addTearDown(controller.dispose);
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SingleChildScrollView(
            child: PetSettingsSection(
              device: controller.devices.single,
              controller: controller,
              pickFile: pick ?? () async => '/tmp/boba.png',
              resolveSource: resolve,
              loadSheet: loadSheet ?? (_) async => null,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(() => tester.pumpWidget(const SizedBox()));
  }

  testWidgets('locked when the dial lacks pets', (tester) async {
    daemon.supported = false;
    await build(tester);
    expect(
      find.text('Update the dial’s firmware to use custom pets'),
      findsOneWidget,
    );
    final choose = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Choose file…'),
    );
    expect(choose.onPressed, isNull);
  });

  testWidgets('one row for every agent, no per-engine choice', (tester) async {
    daemon
      ..held = ['boba', 'old', 'older']
      ..mapping = {
        'all': null,
        'engines': {'claude': 'old'},
      };
    await build(tester);
    expect(find.text('Pet'), findsOneWidget);
    expect(find.text('Default'), findsOneWidget);
    expect(find.byKey(const ValueKey('pet-row-all')), findsOneWidget);
    expect(find.text('Per engine'), findsNothing);
    expect(find.text('Apply to all'), findsNothing);
    expect(find.byType(SegmentedButton<bool>), findsNothing);
    expect(find.text('Choose file…'), findsOneWidget);
    expect(find.text('Choose folder…'), findsOneWidget);
    expect(find.text('Download template'), findsNothing);
    expect(find.textContaining('petdex.dev'), findsOneWidget);
  });

  testWidgets('apply sets all, then resets engine pets left from before', (
    tester,
  ) async {
    daemon
      ..held = ['boba', 'old', 'older']
      ..mapping = {
        'all': null,
        'engines': {'claude': 'old', 'codex': 'older'},
      };
    await build(tester);
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    daemon.requests.clear();
    daemon.payloads.clear();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();
    expect(daemon.payloads['pet_apply'], [
      {'target': 'all', 'id': 'boba'},
    ]);
    expect(
      {for (final r in daemon.payloads['pet_reset']!) r['target']},
      {'claude', 'codex'},
    );
    expect(
      daemon.requests.indexOf('pet_apply'),
      lessThan(daemon.requests.indexOf('pet_reset')),
    );
    expect(daemon.mapping, {'all': 'boba', 'engines': <String, String>{}});
  });

  testWidgets('a failed apply leaves the engine pets alone', (tester) async {
    daemon
      ..held = ['boba', 'old', 'older']
      ..mapping = {
        'all': null,
        'engines': {'claude': 'old'},
      };
    await build(tester);
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    daemon.applyReply = {'error': 'TOO_MANY', 'message': 'Up to 4 pets'};
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();
    expect(find.text('Up to 4 pets'), findsOneWidget);
    expect(daemon.payloads['pet_reset'], isNull);
  });

  testWidgets('a folder with pet.json previews under the pet\u2019s own name', (
    tester,
  ) async {
    final dir = Directory.systemTemp.createTempSync('pet-folder-');
    addTearDown(() => dir.deleteSync(recursive: true));
    File('${dir.path}/sheet.png').writeAsBytesSync([1, 2, 3]);
    File('${dir.path}/pet.json').writeAsStringSync(
      jsonEncode({'displayName': 'ddo', 'spritesheetPath': 'sheet.png'}),
    );
    await build(tester, pick: () async => dir.path);
    await tester.runAsync(() async {
      await tester.tap(find.text('Choose file…'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pumpAndSettle();
    final sent = daemon.payloads['pet_preview']!.single;
    expect((sent['path'] as String).endsWith('/sheet.png'), isTrue);
    expect(sent['name'], 'ddo');
    expect(find.text('Apply'), findsOneWidget);
  });

  testWidgets('an unsupported file shows a message and asks nothing', (
    tester,
  ) async {
    await build(tester, pick: () async => '/tmp/boba.gif');
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    expect(daemon.payloads['pet_preview'], isNull);
    expect(find.textContaining('Choose a pet folder'), findsOneWidget);
  });

  testWidgets('choosing a file shows the dial previews and size', (
    tester,
  ) async {
    await build(tester);
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    expect(find.text('On the dial'), findsOneWidget);
    for (final label in ['Rest', 'Working', 'Asking']) {
      expect(find.text(label), findsOneWidget);
    }
    expect(find.text('412 KB · 87 colours'), findsOneWidget);
    expect(
      find.text('Soft edges will look jagged on the dial'),
      findsOneWidget,
    );
    expect(find.text('Apply'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Apply'), findsNothing);
  });

  testWidgets('a sheet error is shown in the row', (tester) async {
    await build(tester);
    daemon.previewReply = {
      'error': 'BAD_SIZE',
      'message': 'The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)',
    };
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    expect(
      find.text('The sheet must be 1536 × 1872 (8 × 9 cells of 192 × 208)'),
      findsOneWidget,
    );
    expect(find.text('Apply'), findsNothing);
  });

  testWidgets('apply shows progress then On dial ✓', (tester) async {
    await build(tester);
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    daemon.sending = {'id': 'boba', 'percent': 40};
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();
    expect(find.text('Sending to dial… 40 %'), findsOneWidget);
    daemon
      ..sending = null
      ..held = ['boba'];
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('Sending to dial… 40 %'), findsNothing);
    expect(find.text('On dial ✓'), findsOneWidget);
  });

  testWidgets('reset clears all and every engine entry', (tester) async {
    await build(tester);
    daemon.mapping = {
      'all': 'boba',
      'engines': {'claude': 'old', 'muse': 'older'},
    };
    await controller.refreshPetStatus(controller.devices.single.key);
    await tester.pumpAndSettle();
    expect(find.text('Custom pet'), findsOneWidget);
    await tester.tap(find.text('Reset'));
    await tester.pumpAndSettle();
    expect(find.text('Default'), findsOneWidget);
    expect(find.text('Custom pet'), findsNothing);
    expect(
      {for (final r in daemon.payloads['pet_reset']!) r['target']},
      {'all', 'claude', 'muse'},
    );
    expect(daemon.mapping, {'all': null, 'engines': <String, String>{}});
  });

  Future<void> chooseAndApply(WidgetTester tester) async {
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Apply'));
    await tester.pumpAndSettle();
  }

  testWidgets('a stranded apply keeps polling until the pet is on the dial', (
    tester,
  ) async {
    await build(tester);
    // After apply the dial reports nothing sending and nothing held yet.
    await chooseAndApply(tester);
    expect(find.text('Waiting for the dial…'), findsOneWidget);
    daemon.sending = {'id': 'boba', 'percent': 55};
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('Sending to dial… 55 %'), findsOneWidget);
    expect(find.text('Waiting for the dial…'), findsNothing);
    daemon
      ..sending = null
      ..held = ['boba'];
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('On dial ✓'), findsOneWidget);
    final polled = daemon.requests.length;
    await tester.pump(const Duration(seconds: 5));
    expect(daemon.requests.length, polled, reason: 'poll stopped');
  });

  testWidgets('the poll gives up after two minutes', (tester) async {
    await build(tester);
    await chooseAndApply(tester);
    await tester.pump(const Duration(seconds: 121));
    final polled = daemon.requests.length;
    await tester.pump(const Duration(seconds: 10));
    expect(daemon.requests.length, polled);
  });

  testWidgets('without a dial the row says it will be sent on connect', (
    tester,
  ) async {
    daemon.mapping = {'all': 'boba', 'engines': <String, String>{}};
    await build(tester, attached: false);
    expect(find.text('Will be sent when the dial connects'), findsOneWidget);
    expect(find.text('Waiting for the dial…'), findsNothing);
  });

  for (final (code, text) in [
    ('memory', 'The dial is out of memory for pets'),
    ('busy', 'The dial holds too many pets'),
    ('crc', 'The pet didn’t arrive intact. Reconnect the dial to try again'),
    ('shape', 'The pet didn’t arrive intact. Reconnect the dial to try again'),
    ('version', 'Update the dial’s firmware for this pet'),
    ('timeout', 'The dial stopped answering. Reconnect it to try again'),
  ]) {
    testWidgets('dial error $code is shown in the row', (tester) async {
      daemon
        ..mapping = {'all': 'boba', 'engines': <String, String>{}}
        ..errors = {'boba': code};
      await build(tester);
      expect(find.text(text), findsOneWidget);
      expect(find.text('Waiting for the dial…'), findsNothing);
    });
  }

  testWidgets('rows show the pet name and thumbnail, not the pack id', (
    tester,
  ) async {
    daemon
      ..mapping = {'all': 'boba-1a2b', 'engines': <String, String>{}}
      ..held = ['boba-1a2b']
      ..pets = {
        'boba-1a2b': {'name': 'Boba', 'thumb': _png},
      };
    await build(tester);
    expect(find.text('Boba'), findsOneWidget);
    expect(find.text('boba-1a2b'), findsNothing);
    final tile = find.byKey(const ValueKey('pet-thumb-all'));
    expect(tester.getSize(tile), const Size(44, 44));
    expect(
      find.descendant(of: tile, matching: find.byType(Image)),
      findsOneWidget,
    );
  });

  /// The frame cycler of the dial preview for [scene].
  dynamic dialCycler(WidgetTester tester, String scene) => tester.widget(
    find.descendant(
      of: find.byKey(ValueKey('pet-dial-$scene-boba')),
      matching: find.byWidgetPredicate(
        (w) => w.runtimeType.toString() == '_FrameCycler',
      ),
    ),
  );

  testWidgets('the Asking preview plays the asking frames when sent', (
    tester,
  ) async {
    await build(tester);
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    final asking = dialCycler(tester, 'asking');
    expect(asking.frames.length, 3);
    expect(asking.stepMs, 90);
    final working = dialCycler(tester, 'working');
    expect(working.frames.length, 1);
    expect(working.stepMs, 120);
  });

  testWidgets('the Asking preview falls back to the small pet', (tester) async {
    daemon.previewReply = _preview()
      ..['frames'] = {
        'small': [_png, _png],
      }
      ..['stepMs'] = {'small': 200};
    await build(tester);
    await tester.tap(find.text('Choose file…'));
    await tester.pumpAndSettle();
    final asking = dialCycler(tester, 'asking');
    expect(asking.frames.length, 2);
    expect(asking.stepMs, 200);
  });

  testWidgets('locked when the daemon lacks pet requests', (tester) async {
    daemon.statusError = {'error': 'UNSUPPORTED', 'message': 'nope'};
    await build(tester);
    expect(
      find.text('Update Harness on this computer to use custom pets'),
      findsOneWidget,
    );
    final choose = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Choose file…'),
    );
    expect(choose.onPressed, isNull);
  });

  testWidgets('an unreachable daemon stops the poll and clears progress', (
    tester,
  ) async {
    await build(tester);
    daemon.sending = {'id': 'boba', 'percent': 40};
    await chooseAndApply(tester);
    expect(find.text('Sending to dial… 40 %'), findsOneWidget);
    daemon.statusError = {'error': 'UNREACHABLE', 'message': 'down'};
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('Sending to dial… 40 %'), findsNothing);
    final polled = daemon.requests.length;
    await tester.pump(const Duration(seconds: 5));
    expect(daemon.requests.length, polled);
  });

  group('row viewer', () {
    Finder card(String row) => find.byKey(ValueKey('pet-sheet-row-$row'));
    Finder chip(String state) => find.byKey(ValueKey('pet-state-$state'));
    Finder inCard(String row, String text) =>
        find.descendant(of: card(row), matching: find.text(text));
    String title(WidgetTester tester) => tester
        .widget<Text>(find.byKey(const ValueKey('pet-viewer-title')))
        .data!;
    bool chipOn(WidgetTester tester, String state) => tester
        .widget<Semantics>(
          find
              .descendant(of: chip(state), matching: find.byType(Semantics))
              .first,
        )
        .properties
        .selected!;
    int frame(WidgetTester tester) => (tester.widget(
      find.byKey(const ValueKey('pet-viewer-art')),
    ) as dynamic).index;
    FilledButton apply(WidgetTester tester) =>
        tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Apply'));

    /// Shows [row] in the viewer, then moves [state] onto it.
    Future<void> move(WidgetTester tester, String state, String row) async {
      await tester.tap(card(row));
      await tester.pump();
      await tester.tap(chip(state));
      await tester.pump();
    }

    const petdexRows = [
      'idle',
      'runningRight',
      'waving',
      'waiting',
      'running',
      'review',
    ];

    testWidgets('a petdex sheet lists a card per row, viewing Working’s', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      // The first preview leaves the mapping to the daemon.
      expect(daemon.payloads['pet_preview']!.single.containsKey('rows'), false);
      for (final (row, label) in [
        ('idle', 'Idle'),
        ('runningRight', 'Running right'),
        ('running', 'Running'),
        ('review', 'Review'),
      ]) {
        expect(inCard(row, label), findsOneWidget);
        expect(inCard(row, '4 frames'), findsOneWidget);
      }
      expect(card('jumping'), findsNothing);
      for (final (state, row) in [
        ('Rest', 'idle'),
        ('Working', 'running'),
        ('Listening', 'review'),
        ('Sending', 'waving'),
        ('Asking', 'waiting'),
      ]) {
        expect(inCard(row, state), findsOneWidget);
      }
      expect(inCard('runningRight', 'Working'), findsNothing);
      expect(title(tester), 'Running');
      expect(chipOn(tester, 'working'), isTrue);
      expect(chipOn(tester, 'rest'), isFalse);
      expect(find.text('Running plays on the dial as'), findsOneWidget);
      expect(find.text('6 rows found · 412 KB · 87 colours'), findsOneWidget);
      expect(find.textContaining('Background removed'), findsNothing);
      expect(find.text('boba · not applied yet'), findsOneWidget);
    });

    testWidgets('tapping a card shows that row in the viewer', (tester) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      await tester.tap(card('idle'));
      await tester.pump();
      expect(title(tester), 'Idle');
      expect(chipOn(tester, 'rest'), isTrue);
      expect(chipOn(tester, 'working'), isFalse);
      expect(daemon.payloads['pet_preview']!.length, 1, reason: 'only viewed');
    });

    testWidgets('a chip moves its state here and asks again, debounced', (
      tester,
    ) async {
      daemon.held = ['boba-2'];
      daemon.previewReply = sheetPreview('boba', petdexRows);
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      daemon.previewReply = sheetPreview(
        'boba-2',
        petdexRows,
        mapping: {
          'rest': 'idle',
          'working': 'runningRight',
          'listening': 'waving',
          'sending': 'waving',
          'asking': 'waiting',
        },
      );
      await move(tester, 'working', 'runningRight');
      expect(chipOn(tester, 'working'), isTrue);
      expect(inCard('runningRight', 'Working'), findsOneWidget);
      expect(inCard('running', 'Working'), findsNothing, reason: 'moved');
      await tester.pump(const Duration(milliseconds: 100));
      await move(tester, 'listening', 'waving');
      expect(apply(tester).onPressed, isNull, reason: 'preview is outdated');
      await tester.pump(const Duration(milliseconds: 200));
      expect(daemon.payloads['pet_preview']!.length, 1, reason: 'debounced');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpAndSettle();
      final sent = daemon.payloads['pet_preview']!;
      expect(sent.length, 2);
      expect(sent.last['rows'], {
        'rest': 'idle',
        'working': 'runningRight',
        'listening': 'waving',
        'sending': 'waving',
        'asking': 'waiting',
      });
      expect(sent.last['path'], sent.first['path']);
      expect(inCard('waving', 'Listening'), findsOneWidget);
      expect(inCard('review', 'Listening'), findsNothing);
      expect(apply(tester).onPressed, isNotNull);
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(daemon.payloads['pet_apply'], [
        {'target': 'all', 'id': 'boba-2'},
      ]);
    });

    testWidgets('a stale reply is ignored; Apply takes the latest preview', (
      tester,
    ) async {
      daemon.held = ['newest'];
      daemon.previewReply = sheetPreview('boba', petdexRows);
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      final replies = <Completer<Map<String, dynamic>>>[];
      daemon.onPreview = (_) {
        final reply = Completer<Map<String, dynamic>>();
        replies.add(reply);
        return reply.future;
      };
      await move(tester, 'working', 'waving');
      await tester.pump(const Duration(milliseconds: 300));
      await move(tester, 'working', 'review');
      await tester.pump(const Duration(milliseconds: 300));
      expect(replies.length, 2);
      replies[1].complete(
        sheetPreview(
          'newest',
          petdexRows,
          mapping: {
            'rest': 'idle',
            'working': 'review',
            'listening': 'review',
            'sending': 'waving',
            'asking': 'waiting',
          },
        ),
      );
      await tester.pump();
      replies[0].complete(sheetPreview('older', petdexRows));
      await tester.pumpAndSettle();
      expect(inCard('review', 'Working'), findsOneWidget);
      expect(inCard('waving', 'Working'), findsNothing);
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(daemon.payloads['pet_apply'], [
        {'target': 'all', 'id': 'newest'},
      ]);
    });

    testWidgets('an empty chosen row shows the daemon’s message', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      daemon.previewReply = {
        'error': 'EMPTY_ROW',
        'message': 'The waving row is empty',
      };
      await move(tester, 'rest', 'waving');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      expect(find.text('The waving row is empty'), findsOneWidget);
      expect(card('idle'), findsOneWidget);
      expect(apply(tester).onPressed, isNull);
    });

    testWidgets('play pauses and resumes; a scrubber tile holds its frame', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pump();
      await tester.pump();
      final start = frame(tester);
      await tester.pump(const Duration(milliseconds: 120));
      expect(frame(tester), (start + 1) % 4, reason: 'plays at 120 ms');
      final play = find.byKey(const ValueKey('pet-viewer-play'));
      expect(
        find.descendant(of: play, matching: find.text('4 frames')),
        findsOneWidget,
      );
      await tester.tap(play);
      await tester.pump();
      final paused = frame(tester);
      await tester.pump(const Duration(milliseconds: 600));
      expect(frame(tester), paused, reason: 'paused');
      await tester.tap(play);
      await tester.pump(const Duration(milliseconds: 120));
      expect(frame(tester), (paused + 1) % 4, reason: 'playing again');
      await tester.tap(find.byKey(const ValueKey('pet-viewer-frame-2')));
      await tester.pump();
      expect(frame(tester), 2);
      await tester.pump(const Duration(milliseconds: 600));
      expect(frame(tester), 2, reason: 'a tile pauses on its frame');
      final tile = tester.widget<Container>(
        find
            .descendant(
              of: find.byKey(const ValueKey('pet-viewer-frame-2')),
              matching: find.byType(Container),
            )
            .first,
      );
      expect(
        ((tile.decoration as BoxDecoration).border as Border).top.width,
        1.5,
        reason: 'highlighted',
      );
    });

    testWidgets('the viewer draws the local sheet at full size', (
      tester,
    ) async {
      final image = (await tester.runAsync(
        () => createTestImage(width: 8 * 96, height: 9 * 104, cache: false),
      ))!;
      daemon.previewReply = sheetPreview('boba', petdexRows);
      final read = <String>[];
      await build(
        tester,
        loadSheet: (path) async {
          read.add(path);
          return PetSheet(image);
        },
      );
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      expect(read, ['/tmp/boba.png']);
      final painter =
          tester
                  .widget<CustomPaint>(
                    find.descendant(
                      of: find.byKey(const ValueKey('pet-viewer-art')),
                      matching: find.byType(CustomPaint),
                    ),
                  )
                  .painter!
              as dynamic;
      // Row "running" is sheet row 7; cells are 96 x 104.
      final Rect source = painter.source;
      expect(source.top, 7 * 104);
      expect(source.size, const Size(96, 104));
      expect(
        find.byType(Image).evaluate().where((e) {
          final w = e.widget as Image;
          return w.image is MemoryImage &&
              find
                  .descendant(
                    of: find.byKey(const ValueKey('pet-viewer-art')),
                    matching: find.byWidget(w),
                  )
                  .evaluate()
                  .isNotEmpty;
        }),
        isEmpty,
        reason: 'no daemon strip in the viewer',
      );
    });

    testWidgets('the viewer and the cards crop to the row’s art', (
      tester,
    ) async {
      final image = (await tester.runAsync(
        () => createTestImage(width: 8 * 96, height: 9 * 104, cache: false),
      ))!;
      daemon.previewReply = sheetPreview('boba', petdexRows);
      const art = Rect.fromLTRB(30, 40, 70, 100);
      await build(
        tester,
        loadSheet: (_) async =>
            PetSheet(image, crops: [for (var r = 0; r < 9; r++) art]),
      );
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      Rect source(Finder of) =>
          (tester
                      .widget<CustomPaint>(
                        find
                            .descendant(
                              of: of,
                              matching: find.byType(CustomPaint),
                            )
                            .last,
                      )
                      .painter!
                  as dynamic)
              .source;
      final viewed = frame(tester);
      expect(
        source(find.byKey(const ValueKey('pet-viewer-art'))),
        art.shift(Offset(viewed * 96.0, 7 * 104)),
        reason: 'row "running" is sheet row 7',
      );
      expect(
        source(find.byKey(const ValueKey('pet-viewer-frame-2'))),
        art.shift(const Offset(2 * 96.0, 7 * 104)),
      );
      expect(source(card('idle')), art, reason: 'frame 0 of row 0');
    });

    testWidgets('a card’s badges stay on one line, the rest as +n', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview(
        'boba',
        petdexRows,
        mapping: {for (final s in petStateLabels.keys) s: 'idle'},
      );
      await build(tester, size: const Size(560, 2400));
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final shown = [
        for (final label in petStateLabels.values)
          if (tester.any(inCard('idle', label))) label,
      ];
      expect(shown, isNotEmpty);
      expect(shown.length, lessThan(5));
      expect(shown, petStateLabels.values.take(shown.length));
      final more = inCard('idle', '+${5 - shown.length}');
      expect(more, findsOneWidget);
      final line = tester.getCenter(more).dy;
      for (final label in shown) {
        expect(tester.getCenter(inCard('idle', label)).dy, line);
      }
      final box = tester.getRect(card('idle'));
      expect(tester.getRect(more).right, lessThanOrEqualTo(box.right));
      expect(
        tester.getRect(inCard('idle', shown.first)).top,
        greaterThan(tester.getRect(inCard('idle', '4 frames')).bottom),
        reason: 'under the title, at the bottom',
      );
      // Every card of the grid is as tall.
      expect({
        for (final row in petdexRows) tester.getSize(card(row)).height,
      }, hasLength(1));
    });

    testWidgets('the choosers sit side by side, folder first', (tester) async {
      await build(tester);
      final folder = tester.getRect(find.text('Choose folder…'));
      final file = tester.getRect(find.text('Choose file…'));
      expect(folder.center.dy, file.center.dy);
      expect(folder.right, lessThan(file.left));
      expect(
        file.center.dy,
        lessThan(tester.getRect(find.text('Default')).bottom),
        reason: 'beside All agents',
      );
    });

    testWidgets('a loose sheet numbers its rows and sends the guess first', (
      tester,
    ) async {
      var cleaned = 0;
      const guess = {
        'rest': 'idle',
        'working': 'runningLeft',
        'listening': 'idle',
        'sending': 'idle',
        'asking': 'waving',
      };
      const loose = ['idle', 'runningRight', 'runningLeft', 'waving'];
      daemon.previewReply = sheetPreview(
        'hero',
        loose,
        mapping: guess,
        frames: 5,
      );
      await build(
        tester,
        pick: () async => '/tmp/hero.jpeg',
        resolve: (path) async => PetSource(
          pngPath: '/tmp/hero-sheet.png',
          name: 'hero',
          loose: true,
          defaultRows: guess,
          cleanup: () async => cleaned++,
        ),
      );
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      final first = daemon.payloads['pet_preview']!.single;
      expect(first['rows'], guess);
      expect(first['name'], 'hero');
      expect(
        find.text(
          'Background removed · 4 rows × 5 frames found · 412 KB · 87 colours',
        ),
        findsOneWidget,
      );
      expect(find.text('hero · not applied yet'), findsOneWidget);
      for (final (i, row) in loose.indexed) {
        expect(inCard(row, 'Row ${i + 1}'), findsOneWidget);
      }
      expect(title(tester), 'Row 3');
      expect(cleaned, 0, reason: 'kept for the next row choice');
      await move(tester, 'working', 'waving');
      expect(title(tester), 'Row 4');
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      expect(daemon.payloads['pet_preview']!.last['rows'], {
        ...guess,
        'working': 'waving',
      });
      expect(
        daemon.payloads['pet_preview']!.last['path'],
        '/tmp/hero-sheet.png',
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(cleaned, 1);
      expect(card('idle'), findsNothing);
    });

    testWidgets('a daemon without sheet rows shows only the dial preview', (
      tester,
    ) async {
      await build(tester);
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
      expect(find.textContaining('plays on the dial as'), findsNothing);
      expect(find.byKey(const ValueKey('pet-viewer-title')), findsNothing);
      expect(chip('rest'), findsNothing);
      expect(find.text('On the dial'), findsOneWidget);
      expect(find.text('Apply'), findsOneWidget);
    });
  });
  group('editor', () {
    const petdexRows = ['idle', 'runningRight', 'waving', 'waiting', 'running'];

    /// An editor for one attached dial; [cleaned] counts each source's
    /// cleanup by its path.
    Future<PetEditor> editor(
      WidgetTester tester,
      Map<String, int> cleaned, {
      Future<PetSheet?> Function(String path)? loadSheet,
      Future<PetSource> Function(String path)? resolveSource,
    }) async {
      final dial = DialState();
      final controller = DevicesController(
        dial: dial,
        accountId: 'pets',
        sendSettings: (_, _) async => true,
        petRequest: daemon.call,
      );
      await controller.load();
      report(dial, [deviceStatus('one')]);
      addTearDown(controller.dispose);
      final editor = PetEditor(
        controller: controller,
        deviceKey: controller.devices.single.key,
        resolveSource:
            resolveSource ??
            (path) async => PetSource(
              pngPath: path,
              name: 'boba',
              cleanup: () async => cleaned[path] = (cleaned[path] ?? 0) + 1,
            ),
        loadSheet: loadSheet ?? (_) async => null,
      );
      return editor;
    }

    testWidgets('a move debounces one re-request; Apply sends its id', (
      tester,
    ) async {
      daemon
        ..held = ['boba-2']
        ..previewReply = sheetPreview('boba', petdexRows);
      final cleaned = <String, int>{};
      final pet = await editor(tester, cleaned);
      await pet.use('/tmp/a.png');
      expect(pet.editing, isTrue);
      expect(pet.viewedRow!.row, 'running', reason: 'starts on Working’s');
      expect(pet.playback.playing, isTrue);
      pet.view('idle');
      expect(pet.viewedRow!.row, 'idle');
      daemon.previewReply = sheetPreview(
        'boba-2',
        petdexRows,
        mapping: {
          'rest': 'idle',
          'working': 'idle',
          'listening': 'review',
          'sending': 'waving',
          'asking': 'waiting',
        },
      );
      pet.choose('working', 'idle');
      expect(pet.statesOf('idle'), ['rest', 'working']);
      expect(pet.statesOf('running'), isEmpty);
      expect(pet.current, isFalse);
      await tester.pump(const Duration(milliseconds: 100));
      pet.choose('asking', 'idle');
      await tester.pump(const Duration(milliseconds: 200));
      expect(daemon.payloads['pet_preview']!.length, 1, reason: 'debounced');
      await tester.pump(const Duration(milliseconds: 100));
      expect(daemon.payloads['pet_preview']!.length, 2);
      expect(daemon.payloads['pet_preview']!.last['rows'], {
        'rest': 'idle',
        'working': 'idle',
        'listening': 'review',
        'sending': 'waving',
        'asking': 'idle',
      });
      expect(pet.current, isTrue);
      expect(pet.preview!.id, 'boba-2');
      await pet.apply();
      expect(daemon.payloads['pet_apply'], [
        {'target': 'all', 'id': 'boba-2'},
      ]);
      expect(pet.editing, isFalse);
      expect(cleaned, {'/tmp/a.png': 1});
      expect(pet.playback.playing, isFalse);
      pet.dispose();
    });

    testWidgets('a stale reply is ignored', (tester) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      final pet = await editor(tester, {});
      await pet.use('/tmp/a.png');
      final replies = <Completer<Map<String, dynamic>>>[];
      daemon.onPreview = (_) {
        final reply = Completer<Map<String, dynamic>>();
        replies.add(reply);
        return reply.future;
      };
      pet.choose('working', 'waving');
      await tester.pump(const Duration(milliseconds: 300));
      pet.choose('working', 'idle');
      await tester.pump(const Duration(milliseconds: 300));
      expect(replies.length, 2);
      replies[1].complete(sheetPreview('newest', petdexRows));
      await tester.pump();
      replies[0].complete(sheetPreview('older', petdexRows));
      await tester.pump();
      expect(pet.preview!.id, 'newest');
      expect(pet.current, isTrue);
      pet.dispose();
    });

    testWidgets('a reply landing during the debounce keeps the newer choice', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      final pet = await editor(tester, {});
      await pet.use('/tmp/a.png');
      final replies = <Completer<Map<String, dynamic>>>[];
      daemon.onPreview = (_) {
        final reply = Completer<Map<String, dynamic>>();
        replies.add(reply);
        return reply.future;
      };
      pet.choose('working', 'waving');
      await tester.pump(const Duration(milliseconds: 300));
      expect(replies.length, 1);
      pet.choose('working', 'idle');
      replies[0].complete(sheetPreview('older', petdexRows));
      await tester.pump();
      expect(pet.statesOf('idle'), contains('working'));
      expect(pet.current, isFalse, reason: 'Apply waits for the newer choice');
      await tester.pump(const Duration(milliseconds: 300));
      expect(replies.length, 2);
      expect(
        (daemon.payloads['pet_preview']!.last['rows'] as Map)['working'],
        'idle',
      );
      replies[1].complete(sheetPreview('newest', petdexRows));
      await tester.pump();
      expect(pet.preview!.id, 'newest');
      expect(pet.current, isTrue);
      pet.dispose();
    });

    testWidgets('an unreadable file ends the attempt instead of sticking', (
      tester,
    ) async {
      final pet = await editor(
        tester,
        {},
        resolveSource: (path) async =>
            throw FileSystemException('Permission denied', path),
      );
      await pet.use('/tmp/locked.png');
      expect(pet.busy, isFalse);
      expect(pet.editing, isFalse);
      expect(pet.error, 'Couldn’t read this pet');
      pet.dispose();
    });

    testWidgets('cancel, a new pick and dispose clean up the sheet', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petdexRows);
      final image = (await tester.runAsync(
        () => createTestImage(width: 8, height: 9, cache: false),
      ))!;
      final images = <ui.Image>[];
      final cleaned = <String, int>{};
      final pet = await editor(
        tester,
        cleaned,
        loadSheet: (_) async {
          if (images.isNotEmpty) return null;
          images.add(image);
          return PetSheet(image);
        },
      );
      await pet.use('/tmp/a.png');
      await tester.pump();
      expect(pet.sheet, isNotNull);
      pet.cancel();
      expect(pet.editing, isFalse);
      expect(pet.sheet, isNull);
      expect(images.single.debugDisposed, isTrue);
      expect(cleaned, {'/tmp/a.png': 1});
      await pet.use('/tmp/b.png');
      await pet.use('/tmp/c.png');
      expect(cleaned, {'/tmp/a.png': 1, '/tmp/b.png': 1});
      expect(pet.editing, isTrue);
      pet.dispose();
      expect(cleaned, {'/tmp/a.png': 1, '/tmp/b.png': 1, '/tmp/c.png': 1});
      expect(pet.playback.playing, isFalse);
    });
  });

  group('devices screen', () {
    setUpAll(loadRealFonts);

    Finder card(String row) => find.byKey(ValueKey('pet-sheet-row-$row'));
    Finder chip(String state) => find.byKey(ValueKey('pet-state-$state'));
    final viewer = find.byKey(const ValueKey('devices-pet-viewer'));
    final panel = find.byKey(const ValueKey('pet-panel'));
    String title(WidgetTester tester) => tester
        .widget<Text>(find.byKey(const ValueKey('pet-viewer-title')))
        .data!;
    var cleaned = <String, int>{};

    Future<void> screen(
      WidgetTester tester, {
      Size size = const Size(1280, 940),
      Brightness brightness = Brightness.light,
      int dials = 1,
    }) async {
      cleaned = {};
      final dial = DialState();
      controller = DevicesController(
        dial: dial,
        accountId: 'pets',
        sendSettings: (_, _) async => true,
        petRequest: daemon.call,
      );
      await controller.load();
      report(dial, [
        for (final id in ['one', 'two'].take(dials)) deviceStatus(id),
      ]);
      addTearDown(controller.dispose);
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      grid.AppTheme.brightness.value = brightness;
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: DevicesScreen(
              controller: controller,
              pickPetFile: () async => '/tmp/boba.png',
              resolvePetSource: (path) async => PetSource(
                pngPath: path,
                name: 'boba',
                cleanup: () async => cleaned[path] = (cleaned[path] ?? 0) + 1,
              ),
              loadPetSheet: (_) async => null,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      addTearDown(() => tester.pumpWidget(const SizedBox()));
    }

    Future<void> choose(WidgetTester tester) async {
      await tester.ensureVisible(find.text('Choose file…'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Choose file…'));
      await tester.pumpAndSettle();
    }

    ScrollPosition page(WidgetTester tester) => tester
        .state<ScrollableState>(
          find
              .descendant(
                of: find.byKey(const PageStorageKey('devices-page')),
                matching: find.byType(Scrollable),
              )
              .first,
        )
        .position;

    testWidgets('the viewer sits in the left column, level with the Pet '
        'section, while the page stays as it is', (tester) async {
      daemon.previewReply = sheetPreview('boba', petRows);
      await screen(tester);
      expect(viewer, findsNothing);
      await choose(tester);
      expect(viewer, findsOneWidget);
      for (final text in [
        'Devices',
        'Brightness',
        'Sound',
        'Voice language',
        'Faces',
      ]) {
        expect(find.text(text), findsOneWidget, reason: text);
      }
      expect(
        tester.getRect(viewer).right,
        lessThan(tester.getRect(panel).left),
      );
      expect(
        tester.getRect(viewer).top,
        moreOrLessEquals(tester.getRect(panel).top, epsilon: .5),
        reason: 'level with the Pet section',
      );
      expect(
        tester.getRect(viewer).top,
        greaterThan(
          tester.getRect(find.byKey(const Key('devices-faces'))).bottom,
        ),
        reason: 'under what the left column holds',
      );
      expect(
        find.descendant(of: panel, matching: find.byType(PetRowViewer)),
        findsNothing,
        reason: 'not drawn twice',
      );
      expect(title(tester), 'Running');
      await tester.ensureVisible(card('idle'));
      await tester.pumpAndSettle();
      await tester.tap(card('idle'));
      await tester.pump();
      expect(title(tester), 'Idle');
      expect(find.text('Idle plays on the dial as'), findsOneWidget);
      await tester.ensureVisible(chip('working'));
      await tester.pumpAndSettle();
      await tester.tap(chip('working'));
      await tester.pump();
      expect(
        find.descendant(of: card('idle'), matching: find.text('Working')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: card('running'), matching: find.text('Working')),
        findsNothing,
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      expect(
        (daemon.payloads['pet_preview']!.last['rows'] as Map)['working'],
        'idle',
      );
      await tester.ensureVisible(find.text('Cancel'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(viewer, findsNothing);
      expect(find.text('Brightness'), findsOneWidget);
      expect(cleaned, {'/tmp/boba.png': 1});
    });

    testWidgets('the viewer follows the Pet section as the page scrolls', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petRows, frames: 8);
      await screen(tester, size: const Size(1100, 560));
      await choose(tester);
      final position = page(tester);
      // The Pet section's top 16 px under the window's.
      final start = position.pixels + tester.getRect(panel).top - 16;
      for (final down in [0.0, 40.0, 120.0]) {
        position.jumpTo(start + down);
        await tester.pump();
        await tester.pump();
        final v = tester.getRect(viewer), p = tester.getRect(panel);
        expect(v.top, moreOrLessEquals(16, epsilon: .5), reason: '+$down');
        expect(v.bottom, lessThanOrEqualTo(p.bottom + .5), reason: '+$down');
      }
      // Past the end of the Pet section, it stops at its bottom.
      position.jumpTo(position.maxScrollExtent);
      await tester.pump();
      await tester.pump();
      final v = tester.getRect(viewer), p = tester.getRect(panel);
      expect(v.top, greaterThanOrEqualTo(p.top - .5));
      expect(v.bottom, lessThanOrEqualTo(p.bottom + .5));
      expect(tester.takeException(), isNull);
    });

    testWidgets('choosing another dial ends the edit and cleans up', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petRows);
      await screen(tester, dials: 2);
      await choose(tester);
      expect(viewer, findsOneWidget);
      // The first dial is selected; the second takes over.
      final other = find.byKey(
        ValueKey('device-card-${controller.devices.last.key}'),
      );
      await tester.ensureVisible(other);
      await tester.pumpAndSettle();
      await tester.tap(other);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Semantics>(
              find.ancestor(of: other, matching: find.byType(Semantics)).first,
            )
            .properties
            .selected,
        isTrue,
      );
      expect(viewer, findsNothing);
      expect(find.text('Apply'), findsNothing);
      expect(find.text('Brightness'), findsOneWidget);
      expect(cleaned, {'/tmp/boba.png': 1});
      expect(tester.takeException(), isNull);
    });

    testWidgets('Apply ends the edit', (tester) async {
      daemon
        ..held = ['boba']
        ..previewReply = sheetPreview('boba', petRows);
      await screen(tester);
      await choose(tester);
      expect(viewer, findsOneWidget);
      await tester.ensureVisible(find.text('Apply'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(daemon.payloads['pet_apply'], [
        {'target': 'all', 'id': 'boba'},
      ]);
      expect(viewer, findsNothing);
      expect(find.text('Devices'), findsOneWidget);
    });

    testWidgets('narrow, the viewer is drawn in the Pet section', (
      tester,
    ) async {
      daemon.previewReply = sheetPreview('boba', petRows);
      await screen(tester, size: const Size(700, 900));
      await choose(tester);
      expect(viewer, findsNothing);
      expect(
        find.descendant(of: panel, matching: find.byType(PetRowViewer)),
        findsOneWidget,
      );
      expect(find.text('Brightness'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    for (final brightness in Brightness.values) {
      testWidgets('${brightness.name}: a 9-row sheet at 1000 x 780', (
        tester,
      ) async {
        daemon.previewReply = sheetPreview('boba', petRows, frames: 8);
        await screen(
          tester,
          size: const Size(1000, 780),
          brightness: brightness,
        );
        await choose(tester);
        expect(tester.takeException(), isNull);
        const labels = [
          'Idle',
          'Running right',
          'Running left',
          'Waving',
          'Jumping',
          'Failed',
          'Waiting',
          'Running',
          'Review',
        ];
        final heights = <double>{};
        for (final (i, row) in petRows.indexed) {
          expect(
            find.descendant(of: card(row), matching: find.text(labels[i])),
            findsOneWidget,
          );
          heights.add(tester.getSize(card(row)).height);
        }
        expect(heights, hasLength(1), reason: 'one card height');
        // Scrolled to the Pet section, the viewer and the section share the
        // window.
        final position = page(tester);
        position.jumpTo(
          (position.pixels + tester.getRect(panel).top - 16).clamp(
            0,
            position.maxScrollExtent,
          ),
        );
        await tester.pump();
        await tester.pump();
        final window = Offset.zero & const Size(1000, 780);
        bool inside(Finder f) {
          final r = tester.getRect(f);
          return window.contains(r.topLeft) &&
              window.contains(r.bottomRight - const Offset(.01, .01));
        }

        for (final scene in ['small', 'working', 'asking']) {
          expect(
            inside(find.byKey(ValueKey('pet-dial-$scene-boba'))),
            isTrue,
            reason: scene,
          );
        }
        expect(
          inside(find.byKey(const ValueKey('pet-viewer-frame-7'))),
          isTrue,
        );
        for (final state in petStateLabels.keys) {
          expect(inside(chip(state)), isTrue, reason: state);
        }
        expect(inside(find.text('Apply')), isTrue);
        // Cancel and Apply sit right under the content, at the right.
        final hint = tester.getRect(
          find.text('A state plays exactly one row; picking it here moves it.'),
        );
        final apply = tester.getRect(
          find.widgetWithText(FilledButton, 'Apply'),
        );
        expect(apply.top - hint.bottom, lessThan(32));
        expect(tester.getRect(panel).right - apply.right, lessThan(24));
        expect(
          tester.getRect(find.widgetWithText(TextButton, 'Cancel')).right,
          lessThan(apply.left),
        );
      });
    }
  });

  group('crops', () {
    /// A straight RGBA sheet of 8 x 9 cells of [w] x [h], clear but for
    /// [boxes]: (row, column, box in the cell).
    Uint8List sheet(int w, int h, List<(int, int, Rect)> boxes) {
      final width = 8 * w;
      final rgba = Uint8List(width * 9 * h * 4);
      for (final (r, c, box) in boxes) {
        for (var y = box.top.toInt(); y < box.bottom; y++) {
          for (var x = box.left.toInt(); x < box.right; x++) {
            rgba[((r * h + y) * width + c * w + x) * 4 + 3] = 255;
          }
        }
      }
      return rgba;
    }

    test('one box per row: the union of its frames, padded', () {
      final rgba = sheet(40, 50, [
        (2, 0, const Rect.fromLTRB(10, 20, 20, 40)),
        (2, 3, const Rect.fromLTRB(14, 10, 30, 38)),
        (5, 7, const Rect.fromLTRB(0, 0, 40, 50)),
      ]);
      final crops = sheetRowCrops(rgba, 8 * 40, 9 * 50, pad: 0);
      expect(crops, hasLength(9));
      expect(crops[2], const Rect.fromLTRB(10, 10, 30, 40));
      expect(crops[5], const Rect.fromLTRB(0, 0, 40, 50));
      expect([crops[0], crops[1], crops[8]], everyElement(isNull));
      // Padding grows the box by a share of its larger side, inside the cell.
      final padded = sheetRowCrops(rgba, 8 * 40, 9 * 50, pad: .1);
      expect(padded[2], const Rect.fromLTRB(7, 7, 33, 43));
      expect(padded[5], const Rect.fromLTRB(0, 0, 40, 50));
    });

    test('a frame is read from its cell, cut to the row’s box', () {
      const cell = Size(192, 208);
      expect(
        frameSource(cell, 7, 2, null),
        const Rect.fromLTWH(384, 1456, 192, 208),
      );
      expect(
        frameSource(cell, 7, 2, const Rect.fromLTRB(40, 60, 150, 200)),
        const Rect.fromLTRB(424, 1516, 534, 1656),
      );
    });

    test('badges: as many as fit, room left for +n', () {
      double more(int n) => 20;
      expect(fitBadges([30, 30, 30], 100, more: more), 3);
      expect(fitBadges([30, 30, 30], 90, more: more), 2);
      expect(fitBadges([30, 30, 30, 30], 80, more: more), 1);
      expect(fitBadges([60], 40, more: more), 0);
      expect(fitBadges([], 40, more: more), 0);
    });

    test('the dial previews share the largest frame’s side', () {
      Uint8List png(int w, int h) => Uint8List.fromList([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255,
      ]);
      expect(
        dialFrameSide([
          [png(102, 112)],
          [png(192, 208)],
          [],
        ]),
        208,
      );
      expect(dialFrameSide([[], []]), 0);
    });
  });
}
