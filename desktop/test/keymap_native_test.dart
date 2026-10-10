import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap_native.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';

import 'keymap_host_test.dart' show MemoryKeymap;

void main() {
  test(
    'the removed creature shortcut is unbound on every desktop platform',
    () {
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      for (final platform in [
        TargetPlatform.macOS,
        TargetPlatform.linux,
        TargetPlatform.windows,
      ]) {
        debugDefaultTargetPlatformOverride = platform;
        final map = MemoryKeymap();
        final chord = platform == TargetPlatform.macOS
            ? 'cmd+alt+shift+d'
            : 'ctrl+alt+shift+d';
        for (final context in [
          KeymapContext.workspace,
          KeymapContext.terminal,
          KeymapContext.picker,
        ]) {
          expect(
            map.current.match(context, [KeyStroke.parse(chord)]).command,
            isNull,
          );
        }
        expect(harnessCommandById, isNot(contains('app.daemon_preview')));
        expect(
          jsonEncode(nativeKeymapSnapshot(map)),
          isNot(contains('app.daemon_preview')),
        );
        expect(
          map.current.match(KeymapContext.workspace, [
            KeyStroke.parse('cmd+ctrl+alt+shift+d'),
          ]).command,
          isNull,
        );
        map.dispose();
      }
    },
  );
  test('the daemon\'s keys reach native only while daemons are on', () {
    final keymap = MemoryKeymap();
    addTearDown(keymap.dispose);
    addTearDown(() => daemonCommandsActive.value = false);
    expect(daemonCommandsActive.value, isFalse);
    final off = jsonEncode(nativeKeymapSnapshot(keymap));
    expect(off, isNot(contains('"app.daemon"')));
    expect(off, isNot(contains('"app.daemon_talk"')));
    expect(off, isNot(contains('"app.daemon_preview"')));
    expect(off, isNot(contains('alt+cmd+t')));
    daemonCommandsActive.value = true;
    final on = jsonEncode(nativeKeymapSnapshot(keymap));
    expect(on, contains('app.daemon_talk'));
    expect(on, contains('alt+cmd+t'));
  });

  test(
    'native payload carries resolved contexts, unbinding and actual hints',
    () async {
      final keymap = MemoryKeymap();
      addTearDown(keymap.dispose);
      final defaults = nativeKeymapSnapshot(keymap);
      for (final context in ['workspace', 'terminal']) {
        final rows = ((defaults['contexts'] as Map)[context] as List)
            .cast<Map>();
        expect(
          rows.singleWhere(
            (row) => (row['keys'] as List).join(' ') == 'cmd+o',
          )['command'],
          'agent.open',
        );
      }
      keymap.apply('''{"bindings":[
      {"keys":"cmd+t","command":null},
      {"keys":"cmd+o","command":"swarm.new"},
      {"keys":"cmd+k","command":null},
      {"keys":"cmd+k cmd+n","command":"swarm.new"},
      {"keys":"cmd+left","command":null,"when":"terminal"},
      {"keys":"cmd+i","command":null},
      {"keys":"cmd+y","command":"models.list"},
      {"keys":"down","command":null,"when":"picker"},
      {"keys":"ctrl+j","command":"picker.previous","when":"picker"}
    ]}''');
      final changed = nativeKeymapSnapshot(keymap);
      final contexts = changed['contexts']! as Map;
      for (final context in KeymapContext.values) {
        final rows = (contexts[context.name] as List).cast<Map>();
        // The daemon's commands exist only while daemons are on (off here).
        final bindings = keymap.current
            .bindingsFor(context)
            .where((b) => harnessCommandActive(b.command!))
            .toList();
        expect(rows.length, bindings.length);
        for (final binding in bindings) {
          final row = rows.singleWhere(
            (row) => (row['keys'] as List).join(' ') == binding.sequence,
          );
          expect(row['command'], binding.command);
          expect(row['hint'], describeKeyBinding(binding));
          expect(
            row['repeatable'],
            harnessCommandById[binding.command]!.repeatable,
          );
          expect(
            row['menuAction'],
            harnessCommandById[binding.command]!.nativeAction,
          );
        }
        expect(
          rows.any((row) => (row['keys'] as List).join(' ') == 'cmd+t'),
          isFalse,
        );
      }
      expect(
        (contexts['terminal'] as List).any(
          (row) => (row['keys'] as List).join(' ') == 'cmd+left',
        ),
        isFalse,
      );
      expect(
        (contexts['workspace'] as List).any(
          (row) => (row['keys'] as List).join(' ') == 'cmd+left',
        ),
        isTrue,
      );
      final fixture = Platform.environment['HARNESS_KEYMAP_FIXTURE_PATH'];
      if (fixture != null) {
        await File(
          fixture,
        ).writeAsString(jsonEncode({'defaults': defaults, 'changed': changed}));
      }
    },
  );
}
