import 'dart:async';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/setting_row.dart';
import '../../terminal/terminal_font_store.dart';
import '../../terminal/terminal_theme.dart';
import '../../terminal/terminal_theme_store.dart';

/// Customize Harness ▸ Terminal: the colours and the face the agent's output is drawn in.
///
/// Laid out in the app's own [SettingRow]s rather than in bare Material, for
/// the same reason Appearance is: a preference reads as a preference here or it
/// reads as a different app one pane over. What this screen adds on top of that
/// shape is the [_Preview] — the terminal is the one setting whose value can
/// only really be judged by looking at it, so the sample is given the room a
/// real pane has instead of the two lines a caption gets.
class TerminalSection extends StatelessWidget {
  const TerminalSection({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      // A SingleChildScrollView, never a ListView — same reason as Appearance:
      // a lazy list keeps children across a rebuild and strands them on the
      // palette they first mounted with.
      child: ValueListenableBuilder<TerminalStyle>(
        valueListenable: terminalFontStore,
        // Nested rather than merged into one builder: the two stores change
        // independently, and this is the pane that has to show both at once.
        builder: (context, style, _) =>
            ValueListenableBuilder<TerminalThemeChoice>(
              valueListenable: terminalThemeStore,
              builder: (context, scheme, _) =>
                  _Controls(style: style, scheme: scheme),
            ),
      ),
    );
  }
}

class _Controls extends StatelessWidget {
  const _Controls({required this.style, required this.scheme});

  final TerminalStyle style;
  final TerminalThemeChoice scheme;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Colour first, then face, then size: the scheme is the change a
        // person notices from across the room, and it is the one that
        // makes the two rows under it look different while they choose.
        SettingRow(
          title: 'Colors',
          control: _SchemeField(scheme: scheme),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Font',
          control: _FamilyField(family: terminalFontStore.family),
        ),
        const SizedBox(height: 10),
        SettingRow(
          title: 'Size',
          control: _SizeStepper(size: style.fontSize),
        ),
        const SizedBox(height: 14),
        _Preview(style: style, scheme: scheme),
        const SizedBox(height: 12),
        const _ResetRow(),
        // Room under the last control so a scrolled-to-bottom pane does
        // not end flush against the window edge.
        const SizedBox(height: 8),
      ],
    );
  }
}

/// The colour-scheme picker.
///
/// Same control as the face picker below it, for the same reason — see
/// [_FamilyField]. Unlike that one this list needs no per-platform guard:
/// colours resolve identically everywhere, so every value is always offered.
class _SchemeField extends StatelessWidget {
  const _SchemeField({required this.scheme});

  final TerminalThemeChoice scheme;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AppSelectField<TerminalThemeChoice>(
      key: const Key('terminal-colour-scheme-dropdown'),
      width: SettingRow.controlWidth,
      value: scheme,
      options: [
        for (final choice in TerminalThemeChoice.values)
          SelectOption(value: choice, label: choice.label),
      ],
      onChanged: (choice) => unawaited(terminalThemeStore.set(choice)),
    );
  }
}

/// The face picker.
///
/// [AppSelectField], not `DropdownButton` — see that widget's doc for why
/// Material's is unusable in this app.
///
/// ⚠️ The rows carry no specimen glyph. A two-character sample (`M0`) was tried
/// in the leading slot and removed: at a menu row's size these four faces are
/// nearly indistinguishable in two glyphs, so it read as a stray mark in front
/// of every name rather than as a preview. The place a face can actually be
/// judged is [_Preview], at the size it will really be drawn.
class _FamilyField extends StatelessWidget {
  const _FamilyField({required this.family});

  final TerminalFontChoice family;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AppSelectField<TerminalFontChoice>(
      key: const Key('terminal-font-family-dropdown'),
      width: SettingRow.controlWidth,
      value: family,
      // The faces this OS actually has, plus whatever is selected. The second
      // half matters: a `state.json` carried over from a Mac selects a face
      // Linux does not offer, and [AppSelectField] draws a value it cannot find
      // among its options as an EMPTY field — so the user's chosen face would
      // read as no choice at all. Showing it, rather than silently rewriting
      // what they picked, keeps the pane honest about what is on.
      //
      // (Material's `DropdownButton` asserts instead of blanking. This app does
      // not use it — see [AppSelectField] — but the list has to be right for
      // the same reason either way.)
      options: [
        for (final choice in {...TerminalFontChoice.available, family})
          SelectOption(value: choice, label: choice.label),
      ],
      onChanged: (choice) => unawaited(terminalFontStore.setFamily(choice)),
    );
  }
}

/// − 13pt + in a recessed well, sized to [SettingRow.controlWidth] so it lines
/// up with the picker above it.
///
/// Both buttons go dead at the bounds rather than staying lit and doing
/// nothing when pressed.
class _SizeStepper extends StatelessWidget {
  const _SizeStepper({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      width: SettingRow.controlWidth,
      height: grid.AppControl.height,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        // A recessed well, the same one [AppSelectField] sits in — the two
        // controls in this column read as one pair.
        color: grid.AppSurface.recess,
        borderRadius: BorderRadius.circular(grid.AppControl.radius),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          AppIconButton(
            key: const Key('terminal-font-size-decrease'),
            icon: Icons.remove_rounded,
            size: 16,
            tooltip: 'Smaller',
            onPressed: size <= TerminalFontStore.minSize
                ? null
                : () => unawaited(terminalFontStore.decreaseSize()),
          ),
          Text(
            '${size.round()}pt',
            style: Theme.of(context).textTheme.bodyMedium
                ?.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
          ),
          AppIconButton(
            key: const Key('terminal-font-size-increase'),
            icon: Icons.add_rounded,
            size: 16,
            tooltip: 'Larger',
            onPressed: size >= TerminalFontStore.maxSize
                ? null
                : () => unawaited(terminalFontStore.increaseSize()),
          ),
        ],
      ),
    );
  }
}

/// A live sample rendered with the exact style about to go into the terminal —
/// if a pick were ever going to misalign, it shows right here before it reaches
/// any remote TUI.
///
/// Given a pane's worth of room rather than a caption's, and drawn on the
/// terminal's own ground ([grid.AppPalette.windowBg], recessed inside the
/// card) so what you are judging is the thing itself.
class _Preview extends StatelessWidget {
  const _Preview({required this.style, required this.scheme});

  final TerminalStyle style;
  final TerminalThemeChoice scheme;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Preview', style: theme.textTheme.titleSmall),
        const SizedBox(height: 10),
        _Screen(style: style, scheme: scheme),
      ],
    );
  }
}

class _Screen extends StatelessWidget {
  const _Screen({required this.style, required this.scheme});

  final TerminalStyle style;
  final TerminalThemeChoice scheme;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // ⚠️ Drawn from the TERMINAL's resolved theme, not from the app's tokens.
    // This sample used to borrow `AppPalette` — fine while the terminal always
    // borrowed it too, and a lie the moment a scheme of its own could be
    // chosen: a user picking Tango would have been shown Harness's ground and
    // told that was the result. `terminalThemeFor` is the same call the real
    // pane makes, so what is judged here is what will be rendered.
    final theme = terminalThemeFor(grid.AppTheme.palette.value, scheme);
    final base = style.toTextStyle(color: theme.foreground);
    final dim = style.toTextStyle(color: theme.brightBlack);
    final ok = style.toTextStyle(color: theme.green);

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: theme.background,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: grid.AppGlass.hair),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      // A sample at 22pt outgrows a narrow pane; it scrolls sideways rather
      // than wrapping, because a wrapped line is exactly what a terminal never
      // does and would misrepresent the face being judged.
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Text.rich(
          // ⚠️ This previews the TERMINAL's font at the TERMINAL's size. Left to
          // the ambient scaler it would grow with the platform's text scale and
          // show the user a size the terminal will never render at.
          textScaler: TextScaler.noScaling,
          TextSpan(
            style: base,
            children: [
              TextSpan(text: 'agent@harness', style: dim),
              const TextSpan(text: ' ❯ flutter test\n'),
              TextSpan(text: '✓', style: ok),
              const TextSpan(text: ' 84 passing '),
              TextSpan(text: '(2.1s)\n', style: dim),
              TextSpan(text: 'agent@harness', style: dim),
              const TextSpan(text: ' ❯ █'),
            ],
          ),
        ),
      ),
    );
  }
}

/// Reset, with the shortcut that does the same thing standing beside it — the
/// macOS habit of teaching the key equivalent at the control it belongs to.
class _ResetRow extends StatelessWidget {
  const _ResetRow();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // ⚠️ Typography only — NOT the colour scheme, even though that row sits on
    // this screen too. The ⌘0 printed beside this button is the shortcut that
    // does the same thing, and ⌘0 in a terminal means "reset the zoom"
    // everywhere; making the button do more than the key it advertises is how
    // the two stop being the same control. The scheme needs no reset of its
    // own: its default is a named option the user can pick straight from the
    // list ('Match app appearance').
    final atDefault = terminalFontStore.isDefault;
    return Wrap(
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 10,
      runSpacing: 8,
      children: [
        Text(
          '⌘0',
          style: grid.AppType.monoMeta(color: grid.AppPalette.textFaint),
        ),
        OutlinedButton(
          key: const Key('terminal-settings-reset-button'),
          // Dead at the default, because that is what pressing it would leave
          // the store at anyway.
          onPressed: atDefault
              ? null
              : () => unawaited(terminalFontStore.reset()),
          child: const Text('Reset font'),
        ),
      ],
    );
  }
}
