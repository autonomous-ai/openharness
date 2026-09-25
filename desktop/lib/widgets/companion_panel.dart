import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../shared/theme/app_theme.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../state/workspace_companion.dart';
import '../state/workspace_onboarding.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';
import 'workspace_bar_control.dart';

Color companionInk(CompanionController pet, TerminalTheme theme) {
  final color = pet.hatching || (pet.identity == null && pet.journey.complete)
      ? theme.yellow
      : pet.identity != null
      ? theme.green
      : Color.lerp(
          theme.foreground,
          theme.yellow,
          .28 + .72 * pet.journey.completedCount / pet.journey.total,
        )!;
  return color.withValues(alpha: pet.statusOpacity);
}

/// An ASCII egg before hatch, one creature afterward. Names and progress
/// belong to the tooltip and panel, never the workspace status line.
class CompanionTabButton extends StatelessWidget {
  const CompanionTabButton({
    super.key,
    required this.controller,
    required this.onPressed,
    this.selected = false,
  });
  final CompanionController controller;
  final VoidCallback onPressed;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        controller,
        terminalThemeStore,
        AppTheme.palette,
      ]),
      builder: (context, _) {
        if (!controller.journey.loaded) return const SizedBox.shrink();
        final cell = workspaceBarCellSizeOf(context);
        final theme = terminalThemeFor(
          AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final ink = companionInk(controller, theme);
        return Semantics(
          value: controller.statusDetail,
          child: WorkspaceBarControl(
            key: const ValueKey('companion-tab-button'),
            label: controller.statusLabel,
            tooltip: controller.statusTooltip,
            selected: selected,
            onPressed: controller.hatching ? null : onPressed,
            builder: (context, emphasized) => SizedBox(
              width: cell.width * (controller.statusColumns + 2),
              height: workspaceBarControlHeight(context),
              child: Center(
                child: Text(
                  controller.statusGlyph,
                  key: const ValueKey('companion-tab-face'),
                  maxLines: 1,
                  softWrap: false,
                  style: workspaceBarTextStyle(
                    color: ink,
                    emphasized: emphasized,
                  ).copyWith(fontFeatures: const [FontFeature.disable('liga')]),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// A short terminal note beside the egg. It never takes focus on arrival.
class CompanionNotice extends StatelessWidget {
  const CompanionNotice({
    super.key,
    required this.message,
    this.action,
    this.onAction,
  });
  final String message;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([terminalThemeStore, AppTheme.palette]),
      builder: (context, _) {
        final theme = terminalThemeFor(
          AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final cell = workspaceBarCellSizeOf(context);
        return Material(
          color: theme.background,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(kTerminalCornerRadius),
            side: terminalPaneBorder(focused: true),
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: cell.width,
              vertical: cell.height / 2,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      message,
                      style: workspaceBarTextStyle(color: theme.foreground),
                    ),
                  ),
                ),
                if (action != null && onAction != null) ...[
                  SizedBox(width: cell.width),
                  WorkspaceBarControl(
                    label: action!,
                    onPressed: onAction,
                    builder: (context, emphasized) => SizedBox(
                      width: workspaceBarTextSizeOf(context, '[ $action ]').width,
                      height: workspaceBarControlHeight(context),
                      child: Center(
                        child: Text(
                          '[ $action ]',
                          style: workspaceBarTextStyle(
                            color: theme.yellow,
                            emphasized: emphasized,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

class CompanionPanel extends StatefulWidget {
  const CompanionPanel({
    super.key,
    required this.controller,
    required this.onClose,
    required this.onStep,
    required this.shortcut,
  });
  final CompanionController controller;
  final VoidCallback onClose;
  final ValueChanged<OnboardingStep> onStep;
  final String? Function(OnboardingStep) shortcut;

  @override
  State<CompanionPanel> createState() => _CompanionPanelState();
}

class _CompanionPanelState extends State<CompanionPanel> {
  final _name = TextEditingController();
  final _message = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Companion');
  final _hatchFocus = FocusNode(debugLabel: 'Hatch companion');
  final _stepFocus = {
    for (final step in WorkspaceOnboarding.hatchSteps)
      step: FocusNode(debugLabel: 'Companion discovery: ${step.name}'),
  };
  final _nameFocus = FocusNode(debugLabel: 'Companion name');
  final _messageFocus = FocusNode(debugLabel: 'Companion conversation');
  bool _renaming = false;
  bool _notes = false, _ready = false;
  OnboardingStep? _selectedStep;
  int _completedCount = 0;
  String? _nameError;
  CompanionController get pet => widget.controller;
  WorkspaceOnboarding get journey => pet.journey;

  @override
  void initState() {
    super.initState();
    _selectedStep = journey.nextHatchStep;
    _completedCount = journey.completedCount;
    _ready = pet.identity != null && !pet.hatching;
    pet.addListener(_readyChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focusPrimary();
    });
  }

  void _readyChanged() {
    final ready = pet.identity != null && !pet.hatching;
    if (journey.completedCount != _completedCount) {
      _completedCount = journey.completedCount;
      _selectedStep = journey.nextHatchStep;
      if (pet.identity == null && _focus.hasFocus) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && pet.identity == null) _focusPrimary();
        });
      }
    }
    if (ready && !_ready) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_renaming) _messageFocus.requestFocus();
      });
    }
    _ready = ready;
  }

  void _focusPrimary() {
    if (_ready) {
      _messageFocus.requestFocus();
    } else if (journey.complete) {
      _hatchFocus.requestFocus();
    } else {
      (_stepFocus[_selectedStep ?? journey.nextHatchStep] ?? _focus)
          .requestFocus();
    }
  }

  void _moveStep(int direction) {
    final steps = WorkspaceOnboarding.hatchSteps;
    final current = steps.indexOf(
      _selectedStep ?? journey.nextHatchStep ?? steps.first,
    );
    final next = steps[(current + direction) % steps.length];
    setState(() => _selectedStep = next);
    _stepFocus[next]!.requestFocus();
  }

  void _hatch() =>
      pet.hatch(reduceMotion: MediaQuery.disableAnimationsOf(context));

  @override
  void didUpdateWidget(CompanionPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != pet) {
      oldWidget.controller.removeListener(_readyChanged);
      pet.addListener(_readyChanged);
      _message.clear();
      _renaming = _notes = false;
      _selectedStep = journey.nextHatchStep;
      _completedCount = journey.completedCount;
      _readyChanged();
    }
  }

  @override
  void dispose() {
    _name.dispose();
    pet.removeListener(_readyChanged);
    _message.dispose();
    _focus.dispose();
    _hatchFocus.dispose();
    for (final focus in _stepFocus.values) {
      focus.dispose();
    }
    _nameFocus.dispose();
    _messageFocus.dispose();
    super.dispose();
  }

  void _rename() {
    if (journey.nameCompanion(_name.text)) {
      setState(() {
        _renaming = false;
        _nameError = null;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _messageFocus.requestFocus();
      });
      pet.pet();
    } else {
      setState(() => _nameError = 'Choose a name with 1–24 characters.');
    }
  }

  void _say() {
    if (pet.say(_message.text)) {
      _message.clear();
      _messageFocus.requestFocus();
    }
  }

  void _escape() {
    if (_renaming || _notes) {
      setState(() {
        _renaming = false;
        _notes = false;
      });
      _messageFocus.requestFocus();
    } else {
      widget.onClose();
    }
  }

  void _beginRename() {
    final name = pet.identity!.name;
    _name.value = TextEditingValue(
      text: name,
      selection: TextSelection(baseOffset: 0, extentOffset: name.length),
    );
    setState(() {
      _renaming = true;
      _nameError = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _renaming) _nameFocus.requestFocus();
    });
  }

  late Size _cell;
  TerminalTheme get _theme =>
      terminalThemeFor(AppTheme.palette.value, terminalThemeStore.value);
  TextStyle _ink([Color? color]) =>
      terminalContentStyle(color: color ?? _theme.foreground)
          .copyWith(fontFeatures: const [FontFeature.disable('liga')]);
  Color get _muted => _theme.foreground.withValues(alpha: .55);
  ButtonStyle get _buttonStyle =>
      TextButton.styleFrom(
        minimumSize: Size.zero,
        fixedSize: Size.fromHeight(_cell.height),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: _theme.foreground,
        shape: const RoundedRectangleBorder(),
        splashFactory: NoSplash.splashFactory,
      ).copyWith(
        overlayColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.any(
                {
                  WidgetState.hovered,
                  WidgetState.focused,
                  WidgetState.pressed,
                }.contains,
              )
              ? _theme.selection.withValues(alpha: .5)
              : Colors.transparent,
        ),
      );
  Widget _action(
    String label,
    VoidCallback? action, {
    Key? key,
    FocusNode? focusNode,
  }) => TextButton(
    key: key,
    focusNode: focusNode,
    onPressed: action,
    style: _buttonStyle,
    child: Text(label, style: _ink(_theme.cursor)),
  );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        pet,
        terminalFontStore,
        terminalThemeStore,
        AppTheme.palette,
      ]),
      builder: (context, _) {
        _cell = terminalCellSizeOf(context);
        return CallbackShortcuts(
          bindings: {
            const SingleActivator(LogicalKeyboardKey.escape): _escape,
            if (pet.identity == null && !journey.complete) ...{
              const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
                  _moveStep(1),
              const SingleActivator(LogicalKeyboardKey.keyJ): () =>
                  _moveStep(1),
              const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
                  _moveStep(-1),
              const SingleActivator(LogicalKeyboardKey.keyK): () =>
                  _moveStep(-1),
            },
          },
          child: Focus(
            focusNode: _focus,
            autofocus: true,
            child: TextSelectionTheme(
              data: TextSelectionThemeData(
                selectionColor: _theme.selection,
                cursorColor: _theme.cursor,
              ),
              child: Material(
                color: _theme.background,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(kTerminalCornerRadius),
                  side: terminalPaneBorder(focused: true),
                ),
                clipBehavior: Clip.antiAlias,
                child: SingleChildScrollView(
                  padding: EdgeInsets.symmetric(
                    horizontal: _cell.width * 2,
                    vertical: _cell.height,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final compact =
                              constraints.maxWidth < _cell.width * 28;
                          final title = pet.identity == null
                              ? 'Hatch your companion'
                              : pet.hatching
                              ? 'Someone is waking up...'
                              : pet.identity!.name;
                          return Row(
                            children: [
                              Expanded(
                                child: Text(
                                  compact && pet.identity == null
                                      ? 'Your companion'
                                      : compact && pet.hatching
                                      ? 'Waking up...'
                                      : title,
                                  semanticsLabel: title,
                                  style: _ink(),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              SizedBox(width: _cell.width),
                              Tooltip(
                                message: 'Close companion',
                                child: _action('[x]', widget.onClose),
                              ),
                            ],
                          );
                        },
                      ),
                      if (pet.identity == null)
                        ..._egg(context)
                      else
                        ..._creature(context),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  List<Widget> _egg(BuildContext context) {
    final next = _selectedStep ?? journey.nextHatchStep;
    final guidance = switch (next) {
      OnboardingStep.harnesses => 'Ask a harness for one useful result.\nIts finished reply completes this step.',
      OnboardingStep.machines => 'Work on another computer from here.\nConnect it to complete this step.',
      OnboardingStep.store => 'Pick a non-coding harness in the Store.\nIts finished reply completes this step.',
      _ => '',
    };
    return [
      SizedBox(height: _cell.height),
      LayoutBuilder(
        builder: (context, constraints) {
          final face = Tooltip(
            message: journey.complete
                ? 'Hatch your companion'
                : 'Knock on the egg',
            child: TextButton(
              key: const ValueKey('companion-egg-knock'),
              onPressed: journey.complete ? _hatch : pet.knock,
              style: _buttonStyle.copyWith(
                fixedSize: WidgetStatePropertyAll(
                  Size(_cell.width * pet.statusColumns, _cell.height),
                ),
              ),
              child: Text(
                pet.statusGlyph,
                semanticsLabel: journey.complete
                    ? 'Ready to hatch'
                    : 'Knock on the egg',
                style: _ink(companionInk(pet, _theme)),
              ),
            ),
          );
          final description = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(switch (journey.total - journey.completedCount) {
                3 => 'Three discoveries to hatch.',
                2 => 'Two discoveries to hatch.',
                1 => 'One discovery to hatch.',
                _ => 'Ready to hatch.',
              }, style: _ink()),
              Semantics(
                liveRegion: pet.eggReply != null,
                child: Text(
                  pet.eggReply ??
                      (journey.complete
                          ? 'Press Enter to say hello.'
                          : 'Explore in any order.'),
                  key: const ValueKey('companion-egg-reply'),
                  style: _ink(_muted),
                ),
              ),
            ],
          );
          if (constraints.maxWidth < _cell.width * 36) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                face,
                SizedBox(height: _cell.height),
                description,
              ],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              face,
              SizedBox(width: _cell.width * 2),
              Expanded(child: description),
            ],
          );
        },
      ),
      SizedBox(height: _cell.height),
      for (final step in WorkspaceOnboarding.hatchSteps)
        Tooltip(
          message: step.mission,
          child: TextButton(
            key: ValueKey('companion-step-${step.name}'),
            focusNode: _stepFocus[step],
            onFocusChange: (focused) {
              if (focused && _selectedStep != step) {
                setState(() => _selectedStep = step);
              }
            },
            onPressed: () => widget.onStep(step),
            style: _buttonStyle,
            child: LayoutBuilder(
              builder: (context, constraints) => Row(
                children: [
                  Text(
                    journey.completed(step) ? '[x]' : '[ ]',
                    style: _ink(
                      journey.completed(step) ? _theme.green : _muted,
                    ),
                  ),
                  SizedBox(width: _cell.width),
                  Expanded(
                    child: Text(
                      constraints.maxWidth < _cell.width * 31
                          ? switch (step) {
                              OnboardingStep.harnesses => 'First task',
                              OnboardingStep.machines => 'Add a machine',
                              OnboardingStep.store => 'Beyond code',
                              OnboardingStep.models => 'Local model',
                            }
                          : switch (step) {
                              OnboardingStep.harnesses =>
                                'Finish your first task',
                              OnboardingStep.machines =>
                                'Connect another computer',
                              OnboardingStep.store =>
                                'Make something beyond code',
                              OnboardingStep.models => 'Try a local model',
                            },
                      semanticsLabel: step.mission,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _ink(journey.completed(step) ? _muted : null),
                    ),
                  ),
                  if (constraints.maxWidth >= _cell.width * 35)
                    if (widget.shortcut(step) case final hint?) ...[
                      SizedBox(width: _cell.width * 2),
                      Text(
                        hint,
                        style: _ink(step == next ? _theme.cursor : _muted),
                      ),
                    ],
                ],
              ),
            ),
          ),
        ),
      if (!journey.complete) ...[
        SizedBox(height: _cell.height),
        Text(
          guidance,
          key: const ValueKey('companion-step-guidance'),
          style: _ink(_muted),
        ),
      ],
      SizedBox(height: _cell.height),
      LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < _cell.width * 34;
          final action = _action(
            journey.complete
                ? '[ hatch ]'
                : switch (next) {
                    OnboardingStep.harnesses =>
                      compact ? '[ new harness ]' : '[ start a harness ]',
                    OnboardingStep.machines =>
                      compact ? '[ machines ]' : '[ open machines ]',
                    OnboardingStep.store =>
                      compact ? '[ store ]' : '[ explore the store ]',
                    _ => '[ continue ]',
                  },
            journey.complete
                ? _hatch
                : next == null
                ? null
                : () => widget.onStep(next),
            focusNode: _hatchFocus,
            key: const ValueKey('companion-hatch-action'),
          );
          return Row(
            children: [
              Expanded(
                child: constraints.maxWidth < _cell.width * 27
                    ? const SizedBox.shrink()
                    : Text(
                        journey.complete ? 'enter' : 'j/k select',
                        style: _ink(_muted),
                      ),
              ),
              action,
            ],
          );
        },
      ),
    ];
  }

  InputDecoration _prompt(String prefix, {String? hint, String? error}) =>
      InputDecoration(
        prefixText: prefix.isEmpty ? null : prefix,
        prefixStyle: _ink(_muted),
        hintText: hint,
        hintStyle: _ink(_muted),
        counterText: '',
        errorText: error,
        errorStyle: _ink(_theme.red),
        isDense: true,
        filled: false,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        contentPadding: EdgeInsets.zero,
      );

  List<Widget> _creature(BuildContext context) {
    final identity = pet.identity!;
    return [
      SizedBox(height: _cell.height),
      LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxWidth < _cell.width * 28;
          final face = Tooltip(
            message: 'Boop ${identity.name}',
            child: TextButton(
              key: const ValueKey('companion-boop'),
              onPressed: pet.hatching ? null : () => pet.say('boop'),
              style: _buttonStyle.copyWith(
                fixedSize: WidgetStatePropertyAll(
                  Size(_cell.width * pet.statusColumns, _cell.height),
                ),
              ),
              child: Text(
                pet.glyph,
                key: const ValueKey('companion-panel-face'),
                semanticsLabel: pet.hatching
                    ? 'Hatching your companion'
                    : '${identity.species.label}, ${pet.mood.name}',
                style: _ink(companionInk(pet, _theme)),
              ),
            ),
          );
          final description = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                pet.hatching ? 'hello, world.' : pet.mood.name,
                key: const ValueKey('companion-mood'),
                style: _ink(),
              ),
              Text(
                pet.hatching ? 'Someone is waking up...' : pet.reason,
                key: const ValueKey('companion-mood-reason'),
                style: _ink(_muted),
              ),
            ],
          );
          return compact
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    face,
                    SizedBox(height: _cell.height),
                    description,
                  ],
                )
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    face,
                    SizedBox(width: _cell.width * 2),
                    Expanded(child: description),
                  ],
                );
        },
      ),
      if (!pet.hatching) ...[
        SizedBox(height: _cell.height),
        Semantics(
          liveRegion: true,
          child: Text(
            pet.quote,
            key: const ValueKey('companion-reply'),
            style: _ink(),
          ),
        ),
        SizedBox(height: _cell.height),
        if (_renaming) ...[
          TextField(
            key: const ValueKey('companion-name-input'),
            controller: _name,
            focusNode: _nameFocus,
            maxLength: 24,
            style: _ink(),
            cursorWidth: _cell.width,
            cursorHeight: _cell.height,
            cursorColor: _theme.cursor,
            decoration: _prompt('name > ', error: _nameError),
            onSubmitted: (_) => _rename(),
          ),
          SizedBox(height: _cell.height),
          Wrap(
            spacing: _cell.width * 2,
            children: [
              _action('[ cancel ]', () {
                setState(() => _renaming = false);
                _messageFocus.requestFocus();
              }),
              _action('[ save name ]', _rename),
            ],
          ),
        ] else ...[
          Text('Small talk. Ready-made replies.', style: _ink(_muted)),
          LayoutBuilder(
            builder: (context, constraints) => SizedBox(
              height: _cell.height,
              child: Row(
                children: [
                  Text('say > ', style: _ink(_muted)),
                  Expanded(
                    child: Semantics(
                      label: 'Talk to your companion',
                      child: TextField(
                        key: const ValueKey('companion-message-input'),
                        controller: _message,
                        focusNode: _messageFocus,
                        maxLength: 160,
                        maxLines: 1,
                        textInputAction: TextInputAction.send,
                        style: _ink(),
                        cursorWidth: _cell.width,
                        cursorHeight: _cell.height,
                        cursorColor: _theme.cursor,
                        decoration: _prompt(
                          '',
                          hint: 'hello, pep talk, /help',
                        ).copyWith(isCollapsed: true),
                        onSubmitted: (_) => _say(),
                      ),
                    ),
                  ),
                  if (constraints.maxWidth >= _cell.width * 24) ...[
                    SizedBox(width: _cell.width),
                    _action('[ say ]', _say),
                  ],
                ],
              ),
            ),
          ),
          SizedBox(height: _cell.height),
          Wrap(
            spacing: _cell.width * 2,
            runSpacing: _cell.height,
            children: [
              _action('[ pet ]', pet.pet),
              _action(
                '[ ${identity.species.habit} ]',
                () => pet.playHabit(
                  reduceMotion: MediaQuery.disableAnimationsOf(context),
                ),
              ),
              _action(
                pet.napping ? '[ wake ]' : '[ nap ]',
                pet.napping ? pet.wake : pet.nap,
              ),
            ],
          ),
          SizedBox(height: _cell.height),
          Wrap(
            spacing: _cell.width * 2,
            runSpacing: _cell.height,
            children: [
              _action(
                _notes ? '[ less ]' : '[ about me ]',
                () => setState(() => _notes = !_notes),
              ),
              _action(
                identity.name == identity.species.label
                    ? '[ give me a name ]'
                    : '[ rename ]',
                _beginRename,
              ),
            ],
          ),
        ],
        if (_notes) ...[
          SizedBox(height: _cell.height),
          Text(
            '${identity.species.label} · ${identity.species.personality}',
            style: _ink(),
          ),
          Text(
            'A few ready-made replies, just for fun.\nMessages are not saved or sent.',
            style: _ink(_muted),
          ),
          SizedBox(height: _cell.height),
          Semantics(
            checked: identity.quiet,
            child: _action(
              '${identity.quiet ? '[x]' : '[ ]'} Quiet mode',
              () => journey.setCompanionQuiet(!identity.quiet),
            ),
          ),
          Text('Same company. Still expressions.', style: _ink(_muted)),
          SizedBox(height: _cell.height),
          Text('My little moods', style: _ink()),
          for (final mood in CompanionMood.values) ...[
            SizedBox(height: _cell.height),
            Text(
              '${identity.species.pose(mood).padRight(10)} ${mood.name}',
              style: _ink(),
            ),
            Text(mood.trigger, style: _ink(_muted)),
          ],
        ],
      ],
    ];
  }
}
