import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/models.dart' show Agent;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'engine_identity.dart';

/// The one "Edit name" dialog, opened from every place a name is shown.
///
/// Pulled out of the rail so the pane header could use it too: two copies would
/// have been two sets of error handling for one rename, and the second is the
/// one that quietly stops matching.
///
/// Keyboard-complete on purpose — autofocus, Enter submits, Escape closes —
/// because the way in is a double click but the way through should never need
/// the mouse again.
///
/// And sized for a thumb as much as for a pointer, because the other way in is
/// the phone's `⋯` sheet: the name at 17pt in a 50pt field, selected so the
/// first key replaces it, and 46pt buttons. The title stays small — it names
/// the act; the name is what the dialog is for.
Future<void> showAgentRenameDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String currentName,
) => showAppDialog<void>(
  context: context,
  builder: (_) => _RenameAgentDialog(
    notifier: notifier,
    machineId: machineId,
    agentId: agentId,
    currentName: currentName,
  ),
);

/// The field's corner. Its focus ring stands 4 outside it, on the same curve.
const double _fieldRadius = 12;

/// ⚠️ A widget that OWNS its controller, not a `StatefulBuilder` over one made
/// beside `showDialog`.
///
/// That is what this file used to be, and it crashed the app on Escape: the
/// controller was disposed the moment `showDialog`'s future resolved, which is
/// when the route STARTS animating out — the dialog is still on screen and
/// still rebuilding for the length of that transition, and the first rebuild
/// after the dispose threw "A TextEditingController was used after being
/// disposed" and took the window to a red screen.
///
/// A `State` disposes on unmount instead, which happens after the transition
/// has finished and the route is gone, so there is nothing left to rebuild.
class _RenameAgentDialog extends StatefulWidget {
  const _RenameAgentDialog({
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.currentName,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;
  final String currentName;

  @override
  State<_RenameAgentDialog> createState() => _RenameAgentDialogState();
}

class _RenameAgentDialogState extends State<_RenameAgentDialog> {
  /// Opens with the whole name selected, as the tab rename dialog does: the
  /// name is there to be replaced, so the first key wipes it, and a thumb that
  /// meant to edit it still has the caret.
  late final _controller = TextEditingController(text: widget.currentName)
    ..selection = TextSelection(
      baseOffset: 0,
      extentOffset: widget.currentName.length,
    );

  /// The field's focus, which is what draws the ring around it.
  final _focus = FocusNode();

  /// Where the agent runs, as it stood when the dialog opened — see [_placeOf].
  late final _place = _placeOf(
    widget.notifier,
    widget.machineId,
    widget.agentId,
  );

  /// The text as of the last edit. The controller also notifies on a caret
  /// move, and only a change to the name itself takes an error back.
  ///
  /// ⚠️ Set in [initState], not by a `late` initializer: that would first run
  /// inside [_onEdit] — after the edit — and read the new text as the old one,
  /// so the first keystroke would change nothing on screen.
  late String _text;

  /// The CLI's refusal, shown under the field. Null until one arrives.
  String? _error;

  /// A rename is on its way to the machine: Save spins, and nothing sends a
  /// second one behind it.
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _text = _controller.text;
    _controller.addListener(_onEdit);
    _focus.addListener(_onFocus);
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  String get _name => _controller.text.trim();

  bool get _unchanged => _name == widget.currentName.trim();

  /// Save is offered only for a name that is there and is new: the same name
  /// sent back was a round trip for nothing, and an empty one was only ever
  /// going to be refused.
  bool get _canSave => !_busy && _name.isNotEmpty && !_unchanged;

  void _onFocus() => setState(() {});

  /// An edit takes back the last refusal — it was about a name that is not
  /// there any more — and moves Save with it.
  void _onEdit() {
    if (_controller.text == _text) return;
    setState(() {
      _text = _controller.text;
      _error = null;
    });
  }

  Future<void> _submit() async {
    if (_busy) return;
    // Enter on the name it already has: nothing to send, and closing is what
    // Save would have done had there been anything to save. An empty name goes
    // through — the notifier refuses it on the spot, without a round trip, and
    // the refusal is the answer the Enter was owed.
    if (_name.isNotEmpty && _unchanged) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await widget.notifier.renameAgent(
      widget.machineId,
      widget.agentId,
      _controller.text,
    );
    if (!mounted) return;
    if (result == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _busy = false;
      _error = result;
    });
    _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // The red tuned as ink on a dark surface, not [grid.AppPalette.dangerFill]:
    // that one is darkened to carry white lettering, and as the lettering
    // itself it measured 3.1:1 on this card.
    final danger = Theme.of(context).colorScheme.error;
    final error = _error;
    return Dialog(
      // 16 from a phone's edges rather than Material's 40, so the field is as
      // wide as the name needs, up to the 360 the dialog stops at on anything
      // wider.
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      child: Semantics(
        scopesRoute: true,
        namesRoute: true,
        explicitChildNodes: true,
        label: 'Rename Harness',
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _heading(),
                const SizedBox(height: 18),
                _field(danger: danger, error: error),
                if (error != null)
                  Semantics(
                    liveRegion: true,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(2, 10, 2, 0),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Padding(
                            padding: const EdgeInsets.only(top: 1),
                            child: Icon(
                              LucideIcons.circleAlert300,
                              size: 15,
                              color: danger,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              error,
                              style: TextStyle(
                                color: danger,
                                fontSize: 13,
                                height: 1.35,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 20),
                _actions(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// What is being renamed: the engine's mark, the act, and where the agent
  /// runs. Small on purpose — the field under it is what the dialog is for.
  Widget _heading() {
    final agent = _place.agent;
    return Row(
      children: [
        if (agent != null) ...[
          EngineMark(
            engine: agent.engine,
            displayName: agent.engineDisplayName,
            size: 32,
          ),
          const SizedBox(width: 12),
        ],
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Rename Harness',
                style: TextStyle(
                  color: grid.AppPalette.textPrimary,
                  fontSize: 17,
                  fontWeight: grid.AppFont.semibold,
                ),
              ),
              if (_place.detail.isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  _place.detail,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: grid.AppPalette.textSecondary,
                    fontSize: 13,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  /// The name, in a field recessed below the card, with a ring around it while
  /// it has focus — in red, while a refusal stands under it.
  Widget _field({required Color danger, required String? error}) {
    final accent = grid.AppPalette.accent;
    final ring = error != null
        ? danger.withValues(alpha: 0.2)
        : _focus.hasFocus
        ? accent.withValues(alpha: 0.3)
        : Colors.transparent;
    OutlineInputBorder border(Color color, {double width = 1}) =>
        OutlineInputBorder(
          borderRadius: BorderRadius.circular(_fieldRadius),
          borderSide: BorderSide(color: color, width: width),
        );
    return AnimatedContainer(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 150),
      curve: Curves.easeOut,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(_fieldRadius),
        // A ring rather than a glow: no blur, spread only, so it reads as the
        // field's edge standing out rather than as light behind it.
        boxShadow: [BoxShadow(color: ring, spreadRadius: 4)],
      ),
      child: TextField(
        controller: _controller,
        focusNode: _focus,
        autofocus: true,
        // Held still while the machine answers: an edit made under the spinner
        // would be a name nobody sent.
        readOnly: _busy,
        textInputAction: TextInputAction.done,
        style: grid.kFieldTextStyle.copyWith(
          fontSize: 17,
          letterSpacing: grid.AppFont.trackingFor(17),
        ),
        onSubmitted: (_) => unawaited(_submit()),
        decoration: InputDecoration(
          filled: true,
          fillColor: grid.AppPalette.panelBg,
          isDense: true,
          constraints: const BoxConstraints(minHeight: 50),
          contentPadding: const EdgeInsets.fromLTRB(14, 15, 8, 15),
          border: border(error != null ? danger : grid.AppGlass.hair),
          enabledBorder: border(error != null ? danger : grid.AppGlass.hair),
          focusedBorder: border(error != null ? danger : accent, width: 1.5),
          suffixIcon: _controller.text.isEmpty || _busy
              ? null
              : IconButton(
                  tooltip: 'Clear',
                  visualDensity: VisualDensity.compact,
                  onPressed: () {
                    _controller.clear();
                    _focus.requestFocus();
                  },
                  icon: Icon(
                    LucideIcons.circleX300,
                    size: 18,
                    color: grid.AppPalette.textFaint,
                  ),
                ),
          suffixIconConstraints: const BoxConstraints(
            minWidth: 44,
            minHeight: 44,
          ),
        ),
      ),
    );
  }

  /// Cancel and Save, half the width each and tall enough for a thumb.
  ///
  /// Cancel is a neutral well rather than accent text: blue lettering on this
  /// card measured 3.0:1, and a way out does not need the accent to be found.
  Widget _actions() {
    final accent = grid.AppPalette.accent;
    return Row(
      children: [
        Expanded(
          child: FilledButton(
            style: _buttonStyle(
              background: grid.AppSurface.recess,
              foreground: grid.AppPalette.textPrimary,
            ),
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: FilledButton(
            style: _buttonStyle(
              background: accent,
              foreground: Colors.white,
              // Kept at full colour while it spins: the press was taken, and a
              // button that greyed out under the thumb would read as refused.
              disabledBackground: _busy
                  ? accent
                  : accent.withValues(alpha: 0.22),
              disabledForeground: _busy
                  ? Colors.white
                  : Colors.white.withValues(alpha: 0.4),
            ),
            onPressed: _canSave ? () => unawaited(_submit()) : null,
            child: _busy
                ? Semantics(
                    label: 'Saving',
                    child: SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                        backgroundColor: Colors.white.withValues(alpha: 0.35),
                      ),
                    ),
                  )
                : const Text('Save'),
          ),
        ),
      ],
    );
  }
}

/// A dialog button at a thumb's size: 46 tall, 16pt, on the field's corner.
///
/// Built on the app's filled button, so everything this leaves unsaid — the
/// shrink-wrapped tap target, the hover overlay — is still the theme's.
ButtonStyle _buttonStyle({
  required Color background,
  required Color foreground,
  Color? disabledBackground,
  Color? disabledForeground,
}) => FilledButton.styleFrom(
  backgroundColor: background,
  foregroundColor: foreground,
  disabledBackgroundColor: disabledBackground,
  disabledForegroundColor: disabledForeground,
  minimumSize: const Size.fromHeight(46),
  padding: const EdgeInsets.symmetric(horizontal: 12),
  shape: RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(_fieldRadius),
  ),
  // `ButtonStyle.textStyle` does not inherit the family from the text theme —
  // see `_buttonTextStyle` in the theme — so it is named here too.
  textStyle: TextStyle(
    fontFamily: grid.AppFont.sans,
    fontFamilyFallback: grid.AppFont.sansFallback,
    fontSize: 16,
    fontWeight: grid.AppFont.semibold,
  ),
);

/// Where an agent runs, for the line under the title: the agent (for its
/// engine's mark) and "machine · folder" — the two names every other place
/// tells it apart by.
///
/// Read once, when the dialog opens. An agent missing from its machine's list
/// leaves the mark out and names the machine alone; the rename then answers
/// for itself.
({Agent? agent, String detail}) _placeOf(
  AppNotifier notifier,
  String machineId,
  String agentId,
) {
  final machine = notifier.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  return (
    agent: agent,
    detail: [
      ?machine?.machine.displayName,
      ?agent?.project?.folder,
    ].where((part) => part.isNotEmpty).join(' · '),
  );
}
