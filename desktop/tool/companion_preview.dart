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
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/theme/workspace_bar_style.dart';
import 'package:harness/state/workspace_companion.dart';
import 'package:harness/state/workspace_onboarding.dart';
import 'package:harness/widgets/companion_panel.dart';
import 'package:harness/widgets/terminal_text_action.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';

import 'companion_welcome_preview.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await configureDesktopWindow();
  runApp(
    ListenableBuilder(
      listenable: Listenable.merge([
        grid.AppTheme.brightness,
        grid.AppTheme.palette,
      ]),
      builder: (context, _) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: grid.AppTheme.brightness.value),
        builder: (context, child) => grid.BrightnessScope(child: child!),
        home: const _Review(),
      ),
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
  bool open = false, welcome = true, reduceMotion = false;
  bool reviewControls = false, invitationSeen = false;
  int progress = 0, turns = 0;
  bool working = false, waiting = false, blocked = false, browsing = false;
  DateTime timeBase = DateTime(2026, 9, 24, 9), clockBase = DateTime.now();
  String hint = 'Preview · New Harness with ⌘N, Open Harness with ⌘P';
  DateTime get time => timeBase.add(DateTime.now().difference(clockBase));

  @override
  void initState() {
    super.initState();
    _newEgg();
    lifecycle = AppLifecycleListener(
      onStateChange: (state) =>
          _environment(foreground: state == AppLifecycleState.resumed),
    );
    channel.setMethodCallHandler((call) async {
      if (call.method == 'companion') {
        _toggle();
      } else if (call.method == 'newAgent' || call.method == 'sessions') {
        _destination(
          call.method == 'newAgent' ? 'agent.new' : 'harnesses.list',
        );
      } else if (call.method == 'new') {
        _showWelcome();
      } else if (call.method == 'keymapCommand') {
        final command = (call.arguments as Map?)?['command'];
        if (command is String) _destination(command);
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

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _environment();
  }

  void _environment({bool foreground = true}) => pet.setEnvironment(
    foreground: foreground,
    reduceMotion: reduceMotion || MediaQuery.disableAnimationsOf(context),
  );

  void _newEgg([CompanionSpecies? species, int completed = 0]) {
    invitationSeen = false;
    final memory = _Memory();
    if (species != null || completed > 0) {
      memory.values[WorkspaceOnboarding.storageKey(scope)] = jsonEncode({
        'completed': WorkspaceOnboarding.hatchSteps
            .take(species == null ? completed : 3)
            .map((s) => s.name)
            .toList(),
        if (species != null)
          'companion': CompanionIdentity(species, species.label).toJson(),
      });
    }
    journey = WorkspaceOnboarding(storage: memory);
    pet = CompanionController(journey, now: () => time)..addListener(_changed);
    progress = species == null
        ? completed
        : WorkspaceOnboarding.hatchSteps.length;
    turns = 0;
    working = waiting = blocked = browsing = false;
    _progress();
    _activity();
  }

  void _replace([CompanionSpecies? species, int completed = 0]) {
    pet.removeListener(_changed);
    pet.dispose();
    journey.dispose();
    setState(() {
      open = true;
      _newEgg(species, completed);
      hint = species == null
          ? 'Egg stage $completed/3 · Discover next plays its gesture; ready eggs can hatch'
          : '${species.label} · choose a mood, play its gesture, or try the conversation';
    });
    _environment();
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
    invitationSeen = true;
    if (journey.complete && pet.identity == null) {
      pet.hatch();
      return;
    }
    setState(() => open = !open);
    _sync();
  }

  void _showWelcome() {
    setState(() {
      open = false;
      welcome = true;
      browsing = false;
      hint = 'Preview · New Harness with ⌘N, Open Harness with ⌘P';
    });
    _activity();
    _sync();
  }

  void _visit() {
    setState(() {
      open = true;
      invitationSeen = true;
    });
    _sync();
  }

  void _destination(String command) {
    setState(() {
      open = false;
      browsing = command == 'app.store';
      hint = switch (command) {
        'agent.new' => 'Preview destination: New Harness (⌘N)',
        'harnesses.list' => 'Preview destination: Open Harness (⌘P)',
        'agent.open' => 'Harnesses · manage your running harnesses',
        'machines.list' => 'Preview destination: Machines · use Discover next to simulate a successful connection',
        'models.list' => 'Models · finish a turn with a local model',
        'app.store' => 'Preview destination: Store · use Discover next to simulate a non-coding harness reply',
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
        {
          'id': 'review',
          'name': welcome ? 'New Tab' : 'Companion review',
          'label': welcome ? '1:new' : '1:review',
        },
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
      'focusedContext': welcome
          ? null
          : {
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
    // Reset the previous fixture reaction so scenarios can be reviewed in any
    // order. Advance only the fixture clock through the completion cooldown.
    _environment(foreground: false);
    _environment();
    pet.wake();
    working = state == 'work';
    waiting = state == 'input';
    blocked = state == 'offline';
    browsing = state == 'browse';
    if (state == 'done') {
      timeBase = time.add(const Duration(seconds: 21));
      clockBase = DateTime.now();
      turns++;
    }
    _activity();
    _changed();
  }

  void _mood(CompanionMood mood) {
    _work('idle');
    if (mood == CompanionMood.asleep) {
      pet.nap();
    } else if (mood != CompanionMood.content) {
      pet.react(mood);
    }
    setState(() {
      open = true;
      hint = '${mood.name} · ${mood.trigger}';
    });
    _sync();
  }

  void _returnFromBreak() {
    _work('idle');
    _environment(foreground: false);
    timeBase = time.add(const Duration(minutes: 16));
    clockBase = DateTime.now();
    _environment();
    setState(
      () =>
          hint = 'Return greeting · the review clock skipped a 16-minute break',
    );
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

  Widget _control(String label, VoidCallback? action) => action != null
      ? TerminalTextAction(label: label, onPressed: action)
      : Semantics(
          button: true,
          enabled: false,
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: terminalCellSizeOf(context).width,
            ),
            child: Text(
              '[ $label ]',
              style: terminalContentStyle(
                color: grid.AppPalette.textSecondary.withValues(alpha: .5),
              ),
            ),
          ),
        );

  @override
  Widget build(BuildContext context) => MediaQuery(
    data: MediaQuery.of(context).copyWith(
      disableAnimations:
          reduceMotion || MediaQuery.disableAnimationsOf(context),
    ),
    child: CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyN, meta: true): () =>
            _destination('agent.new'),
        const SingleActivator(LogicalKeyboardKey.keyP, meta: true): () =>
            _destination('harnesses.list'),
        const SingleActivator(LogicalKeyboardKey.keyT, meta: true):
            _showWelcome,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          backgroundColor: grid.AppPalette.swarmField,
          bottomNavigationBar: Material(
            color: grid.AppPalette.swarmTabBar,
            child: Padding(
              padding: EdgeInsets.all(terminalCellSizeOf(context).width),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          hint,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: terminalContentStyle(
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ),
                      _control('Welcome tab', _showWelcome),
                      _control(
                        reviewControls ? 'Hide controls' : 'Review controls',
                        () {
                          setState(() => reviewControls = !reviewControls);
                        },
                      ),
                    ],
                  ),
                  if (reviewControls) ...[
                    SizedBox(height: terminalCellSizeOf(context).height),
                    Wrap(
                      spacing: terminalCellSizeOf(context).width,
                      runSpacing: terminalCellSizeOf(context).height,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        _control('Companion panel', _visit),
                        _control(
                          'Discover next ($progress/3)',
                          progress < WorkspaceOnboarding.hatchSteps.length
                              ? () {
                                  progress++;
                                  _progress();
                                }
                              : null,
                        ),
                        _control('New egg', () => _replace()),
                        PopupMenuButton<int>(
                          tooltip: 'Jump to an egg stage',
                          onSelected: (stage) => _replace(null, stage),
                          itemBuilder: (_) => [
                            for (var stage = 0; stage <= 3; stage++)
                              PopupMenuItem(
                                value: stage,
                                child: Text(
                                  '$stage/3  ${CompanionController.eggStages[stage]}',
                                  style: terminalContentStyle(),
                                ),
                              ),
                          ],
                          child: Text(
                            '[ egg stages ]',
                            style: terminalContentStyle(),
                          ),
                        ),
                        PopupMenuButton<String>(
                          tooltip: 'Review a creature',
                          onSelected: (name) => _replace(
                            CompanionSpecies.values.firstWhere(
                              (s) => s.name == name,
                            ),
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
                        PopupMenuButton<CompanionMood>(
                          tooltip: 'Review all twelve moods',
                          enabled: pet.identity != null && !pet.hatching,
                          onSelected: _mood,
                          itemBuilder: (_) => [
                            for (final mood in CompanionMood.values)
                              PopupMenuItem(
                                value: mood,
                                child: Text(
                                  '${pet.identity!.species.pose(mood).padRight(10)} ${mood.name}',
                                  style: terminalContentStyle(),
                                ),
                              ),
                          ],
                          child: Text(
                            '[ moods ]',
                            style: terminalContentStyle(),
                          ),
                        ),
                        PopupMenuButton<CompanionDaypart>(
                          tooltip: 'Review time of day',
                          onSelected: (part) {
                            _work('idle');
                            timeBase = DateTime(
                              2026,
                              9,
                              24,
                              [9, 14, 19, 23][part.index],
                            );
                            clockBase = DateTime.now();
                            _environment();
                            pet.wake();
                            setState(() {});
                            _sync();
                          },
                          itemBuilder: (_) => [
                            for (final part in CompanionDaypart.values)
                              PopupMenuItem(
                                value: part,
                                child: Text(
                                  part.name,
                                  style: terminalContentStyle(),
                                ),
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
                        _control('Browse', () => _work('browse')),
                        _control('Idle', () => _work('idle')),
                        _control('Return after break', _returnFromBreak),
                        _control(
                          'Play gesture',
                          pet.identity != null && !pet.hatching
                              ? pet.playHabit
                              : null,
                        ),
                        _control(
                          'Motion: ${reduceMotion ? 'reduced' : 'on'}',
                          () {
                            setState(() => reduceMotion = !reduceMotion);
                            _environment();
                          },
                        ),
                        PopupMenuButton<HarnessPalette>(
                          tooltip: 'Review workspace colors',
                          onSelected: (palette) {
                            grid.AppTheme.palette.value = palette;
                            _changed();
                          },
                          itemBuilder: (_) => [
                            for (final palette in HarnessPalette.values)
                              PopupMenuItem(
                                value: palette,
                                child: Text(
                                  palette.label,
                                  style: terminalContentStyle(),
                                ),
                              ),
                          ],
                          child: Text(
                            '[ palette: ${grid.AppTheme.palette.value.label} ]',
                            style: terminalContentStyle(),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
          body: Stack(
            children: [
              Positioned.fill(
                child: CompanionWelcomePreview(
                  controller: pet,
                  showInvitation: !invitationSeen && !open,
                  onHatch: () => pet.hatch(
                    reduceMotion:
                        reduceMotion || MediaQuery.disableAnimationsOf(context),
                  ),
                  onVisit: _visit,
                  onCommand: _destination,
                ),
              ),
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
        ),
      ),
    ),
  );
}
