/// Isolated review: production companion widgets, in-memory progress, no accounts
/// or transports. The controls below the workspace are only review fixtures.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/widgets/companion_panel.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await configureDesktopWindow();
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: const _Review(),
    ),
  );
}

class _Memory implements LocalKeyValueStore {
  final Map<String, String> values = {};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

class _Review extends StatefulWidget {
  const _Review();
  @override
  State<_Review> createState() => _ReviewState();
}

class _ReviewState extends State<_Review> {
  static const channel = MethodChannel('harness/swarm_tabs');
  static const scope = 'isolated-companion-review';
  late WorkspaceOnboarding journey;
  late CompanionController pet;
  late final AppLifecycleListener lifecycle;
  bool open = false;
  int progress = 0, turns = 0;
  bool working = false, waiting = false, blocked = false, browsing = false;
  DateTime timeBase = DateTime(2026, 9, 24, 9), clockBase = DateTime.now();
  String hint = 'Review controls · no saved app data';
  DateTime get time => timeBase.add(DateTime.now().difference(clockBase));

  @override
  void initState() {
    super.initState();
    _newEgg();
    lifecycle = AppLifecycleListener(
      onStateChange: (state) => pet.setEnvironment(
        foreground: state == AppLifecycleState.resumed,
        reduceMotion: MediaQuery.maybeOf(context)?.disableAnimations ?? false,
      ),
    );
    channel.setMethodCallHandler((call) async {
      if (call.method == 'companion') {
        _toggle();
      } else if (const {
        'harnessControls',
        'machineControls',
        'modelControls',
        'store',
      }.contains(call.method)) {
        _destination(switch (call.method) {
          'harnessControls' => 'agent.open',
          'machineControls' => 'machines.list',
          'modelControls' => 'models.list',
          _ => 'app.store',
        });
      }
      await WidgetsBinding.instance.endOfFrame;
    });
  }

  void _newEgg([CompanionSpecies? species]) {
    final memory = _Memory();
    if (species != null) {
      memory.values[WorkspaceOnboarding.storageKey(scope)] = jsonEncode({
        'completed': OnboardingStep.values.map((s) => s.name).toList(),
        'companion': CompanionIdentity(species, species.label).toJson(),
      });
    }
    journey = WorkspaceOnboarding(storage: memory);
    pet = CompanionController(journey, now: () => time)..addListener(_changed);
    progress = species == null ? 0 : WorkspaceOnboarding.hatchSteps.length;
    turns = 0;
    working = waiting = blocked = browsing = false;
    _progress();
    _activity();
  }

  void _replace([CompanionSpecies? species]) {
    pet.removeListener(_changed);
    pet.dispose();
    journey.dispose();
    setState(() {
      open = true;
      _newEgg(species);
    });
  }

  void _progress() => journey.sync(
    scope: scope,
    observed: WorkspaceOnboarding.hatchSteps.take(progress).toSet(),
    otherComputer: false,
    modelsAvailable: true,
  );
  void _changed() {
    if (mounted) {
      setState(() {});
      _sync();
    }
  }

  void _toggle() {
    if (journey.complete && pet.identity == null) {
      pet.hatch();
      return;
    }
    setState(() => open = !open);
    _sync();
  }

  void _destination(String command) {
    setState(() {
      open = false;
      browsing = command == 'app.store';
      hint = switch (command) {
        'agent.new' => 'New Harness · finish a turn in your project',
        'agent.open' => 'Harnesses · manage your running harnesses',
        'machines.list' => 'Machines · connect another computer',
        'models.list' => 'Models · finish a turn with a local model',
        'app.store' => 'Store · finish a turn in a non-coding harness',
        _ => 'Review controls · no saved app data',
      };
    });
    _activity();
    _sync();
  }

  void _sync() => unawaited(
    channel.invokeMethod('update', {
      'enabled': true,
      'activeId': 'review',
      'tabs': [
        {'id': 'review', 'name': 'Companion review', 'label': '1:review'},
      ],
      'palette': grid.AppTheme.palette.value.nativeColors,
      'barStyle': {
        'family': workspaceBarTextStyle().fontFamily,
        'fallback': workspaceBarTextStyle().fontFamilyFallback,
        'size': workspaceBarFontSize,
        'foreground': terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        ).foreground.toARGB32(),
        'selection': terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        ).selection.toARGB32(),
      },
      'focusedContext': {
        'text': 'M2:harness  (main)',
        'segments': [
          {
            'text': 'M2:harness  (main)',
            'foreground': grid.AppPalette.swarmAccent.toARGB32(),
          },
        ],
        'detail': 'Example workspace context',
        'interactive': false,
      },
      'companion': {
        'visible': journey.loaded,
        'open': open,
        'glyph': pet.statusGlyph,
        'columns': pet.statusColumns,
        'opacity': pet.statusOpacity,
        'foreground': companionInk(
          pet,
          terminalThemeFor(
            grid.AppTheme.palette.value,
            terminalThemeStore.value,
          ),
        ).withValues(alpha: 1).toARGB32(),
        'tooltip': pet.statusTooltip,
        'hatching': pet.hatching,
        'label': pet.statusLabel,
        'detail': pet.statusDetail,
      },
    }),
  );
  void _activity() => pet.sync(
    working: working,
    needsInput: waiting,
    browsing: browsing,
    blocked: blocked,
    completedTurns: turns,
  );
  void _work(String state) {
    working = state == 'work';
    waiting = state == 'input';
    blocked = state == 'offline';
    browsing = false;
    if (state == 'done') turns++;
    _activity();
  }

  @override
  void dispose() {
    lifecycle.dispose();
    channel.setMethodCallHandler(null);
    pet.removeListener(_changed);
    pet.dispose();
    journey.dispose();
    super.dispose();
  }

  Widget _control(String label, VoidCallback? action) => TextButton(
    onPressed: action,
    child: Text(
      label,
      style: terminalContentStyle(color: grid.AppPalette.textSecondary),
    ),
  );

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: grid.AppPalette.swarmField,
    bottomNavigationBar: Material(
      color: grid.AppPalette.swarmTabBar,
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              hint,
              style: terminalContentStyle(color: grid.AppPalette.textSecondary),
            ),
            Wrap(
              spacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _control(
                  'Discover next',
                  progress < WorkspaceOnboarding.hatchSteps.length
                      ? () {
                          progress++;
                          _progress();
                        }
                      : null,
                ),
                _control('New egg', () => _replace()),
                PopupMenuButton<String>(
                  tooltip: 'Review a creature',
                  onSelected: (name) => _replace(
                    CompanionSpecies.values.firstWhere((s) => s.name == name),
                  ),
                  itemBuilder: (_) => [
                    for (final species in CompanionSpecies.values)
                      PopupMenuItem(
                        value: species.name,
                        child: Text(
                          '${species.pose(CompanionMood.content).padRight(10)} ${species.label}',
                          style: terminalContentStyle(),
                        ),
                      ),
                  ],
                  child: Semantics(
                    button: true,
                    label: 'Review creatures',
                    child: ExcludeSemantics(
                      child: Text(
                        '[ creatures ]',
                        style: terminalContentStyle(),
                      ),
                    ),
                  ),
                ),
                PopupMenuButton<CompanionDaypart>(
                  tooltip: 'Review time of day',
                  onSelected: (part) {
                    timeBase = DateTime(
                      2026,
                      9,
                      24,
                      [9, 14, 19, 23][part.index],
                    );
                    clockBase = DateTime.now();
                    pet.setEnvironment(foreground: true);
                    pet.wake();
                    setState(() {});
                    _sync();
                  },
                  itemBuilder: (_) => [
                    for (final part in CompanionDaypart.values)
                      PopupMenuItem(
                        value: part,
                        child: Text(part.name, style: terminalContentStyle()),
                      ),
                  ],
                  child: Semantics(
                    button: true,
                    label: 'Review time of day',
                    child: ExcludeSemantics(
                      child: Text(
                        '[ ${pet.daypart.name} ]',
                        style: terminalContentStyle(),
                      ),
                    ),
                  ),
                ),
                _control('Work', () => _work('work')),
                _control('Input', () => _work('input')),
                _control('Done', () => _work('done')),
                _control('Offline', () => _work('offline')),
                _control('Idle', () => _work('idle')),
              ],
            ),
          ],
        ),
      ),
    ),
    body: Stack(
      children: [
        WorkspaceWelcome(onCommand: _destination),
        if (open) ...[
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                setState(() => open = false);
                _sync();
              },
              child: const SizedBox.expand(),
            ),
          ),
          Positioned(
            top: 8,
            right: 10,
            bottom: 8,
            width: (terminalCellSizeOf(context).width * 46).clamp(
              0,
              MediaQuery.sizeOf(context).width - 20,
            ),
            child: Align(
              alignment: Alignment.topRight,
              child: CompanionPanel(
                controller: pet,
                onClose: () {
                  setState(() => open = false);
                  _sync();
                },
                shortcut: (step) => ['⌘N', '⌘M', '⌘I', '⌘S'][step.index],
                onStep: (step) => _destination(step.command),
              ),
            ),
          ),
        ],
      ],
    ),
  );
}
