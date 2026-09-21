import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../terminal/terminal_font_store.dart';
import 'box_chrome.dart';

/// Opens [LinkMachineScreen] as a modal popup for [machineId], closing itself automatically once
/// linking succeeds or the prompt is dismissed (including a barrier tap/Escape, which counts as an
/// implicit dismiss so the caller's reactive gate doesn't just reopen it next frame).
///
/// This is a deliberate exception to the pane grid's normal "never block other tiles" rule (see
/// `AppNotifier.showMachinePane`'s doc comment) — a machine that still needs linking has nothing
/// else useful to show in its own tile, and a transient blocking prompt reads better here than a
/// permanent docked panel that looks like a second tab.
Future<void> showLinkMachineScreenDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
) async {
  // Opening IS the answer to "was it dismissed?": a Cancel earlier marked the
  // machine so the reactive gates stop insisting, and the gates check that mark
  // before calling here — so anything that reaches this line is a person asking
  // to see it. Clear the mark, or the check inside pops the dialog on its first
  // frame and the row reads as dead.
  notifier.revisitLinkPrompt(machineId);
  await showAppDialog<void>(
    context: context,
    transitionDuration: Duration.zero,
    veilBlur: 0,
    veilTint: Colors.transparent,
    builder: (context) => Dialog(
      alignment: Alignment.topCenter,
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.fromLTRB(16, 56, 16, 18),
      child: ListenableBuilder(
        listenable: notifier,
        builder: (context, _) {
          final state = notifier.stateOf(machineId);
          final stillNeeded =
              state != null &&
              state.needsLink &&
              !notifier.isLinkPromptDismissed(machineId);
          if (!stillNeeded) {
            final route = ModalRoute.of(context);
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (context.mounted && route?.isCurrent == true) {
                Navigator.of(context).pop();
              }
            });
            return const SizedBox.shrink();
          }
          return LinkMachineScreen(
            notifier: notifier,
            machineState: state,
            onClose: () => Navigator.of(context).pop(),
          );
        },
      ),
    ),
  );
  // Any close that isn't "linked successfully" (barrier tap, Escape, the in-card Close button)
  // must count as a dismiss, or the caller's reactive gate would just reopen this next rebuild.
  final state = notifier.stateOf(machineId);
  if (state != null && state.needsLink) {
    notifier.dismissLinkPrompt(machineId);
  }
}

/// Shown for a remote machine the local CLI's relay has no linked trust for yet. The CLI now owns
/// E2EE entirely (see the harness CLI's `harness remote-password set`/`harness link connect`, and
/// src/lib/remoteRelay.ts) — this screen holds no crypto state, it just walks the user through
/// entering the remote password set on the OTHER machine.
class LinkMachineScreen extends StatefulWidget {
  final AppNotifier notifier;
  final MachineState machineState;
  final VoidCallback? onClose;
  const LinkMachineScreen({
    super.key,
    required this.notifier,
    required this.machineState,
    this.onClose,
  });

  @override
  State<LinkMachineScreen> createState() => _LinkMachineScreenState();
}

class _LinkMachineScreenState extends State<LinkMachineScreen> {
  final _passwordController = TextEditingController();
  final _passwordFocus = FocusNode(debugLabel: 'Remote password');
  final _announcer = BoxAnnouncer();
  bool _obscure = true;
  bool _submitting = false;
  bool _showTroubleshootingDetails = false;
  String? _error;

  String get _machineId => widget.machineState.machine.machineId;
  bool get _composing =>
      _passwordController.value.composing.isValid &&
      !_passwordController.value.composing.isCollapsed;

  @override
  void initState() {
    super.initState();
    final pending = widget.notifier.pendingMachineLink(_machineId);
    if (pending != null) {
      _submitting = true;
      unawaited(_finish(pending));
    }
    // The dialog's fallback focus can win autofocus during route insertion.
    // Claim the input once mounted, as the search and creation prompts do.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent != false) {
        _passwordFocus.requestFocus();
      }
    });
  }

  @override
  void dispose() {
    _passwordController.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Future<void> _finish(Future<String?> request) async {
    final error = await request;
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _error = error;
    });
    if (error == null) {
      _passwordController.clear();
    } else {
      _passwordFocus.requestFocus();
      _announcer.row(context, error);
    }
  }

  void _submit() {
    if (_submitting || _composing) return;
    if (_passwordController.text.isEmpty) {
      setState(() => _error = 'Enter the remote password first');
      _passwordFocus.requestFocus();
      _announcer.row(context, _error);
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    unawaited(
      _finish(
        widget.notifier.connectWithPassword(
          _machineId,
          _passwordController.text,
        ),
      ),
    );
  }

  void _close() {
    widget.notifier.dismissLinkPrompt(_machineId);
    widget.onClose?.call();
  }

  void _edited(String _) {
    if (_error != null) setState(() => _error = null);
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isAltPressed ||
        keyboard.isMetaPressed ||
        keyboard.isControlPressed ||
        keyboard.isShiftPressed) {
      return KeyEventResult.ignored;
    }
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    final escape = event.logicalKey == LogicalKeyboardKey.escape;
    if (!enter && !escape) return KeyEventResult.ignored;
    if (_composing) return KeyEventResult.skipRemainingHandlers;
    if (escape) {
      _close();
      return KeyEventResult.handled;
    }
    if (_passwordFocus.hasFocus) {
      _submit();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  String get _progress =>
      switch (widget.notifier.machineLinkStage(_machineId)) {
        'deriving_key' => 'Checking password…',
        'exchanging' || 'verifying' => 'Verifying the link…',
        _ => 'Connecting…',
      };

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.notifier, terminalFontStore]),
    builder: (context, _) {
      final machineName = widget.machineState.machine.displayName;
      return Focus(
        onKeyEvent: _key,
        child: SizedBox(
          width: 620,
          child: TerminalBox(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Flexible(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(14, 12, 14, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Link this machine',
                          style: boxMonoStyle(size: 12, color: kBoxFaint),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          machineName,
                          style: boxMonoStyle(weight: FontWeight.w600),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Enter the remote password set on this machine.',
                          style: boxMonoStyle(size: 12, color: Colors.white70),
                        ),
                        const SizedBox(height: 14),
                        ReadlineKeys(
                          controller: _passwordController,
                          enabled: !_submitting,
                          onChanged: _edited,
                          child: TextField(
                            key: const Key('remote-password-connect-field'),
                            controller: _passwordController,
                            focusNode: _passwordFocus,
                            autofocus: true,
                            readOnly: _submitting,
                            obscureText: _obscure,
                            enableSuggestions: false,
                            autocorrect: false,
                            textInputAction: TextInputAction.done,
                            textAlignVertical: TextAlignVertical.center,
                            style: boxMonoStyle(),
                            decoration: InputDecoration(
                              hintText: 'Remote password for $machineName',
                              hintStyle: boxMonoStyle(color: kBoxFaint),
                              isDense: true,
                              filled: false,
                              border: InputBorder.none,
                              enabledBorder: InputBorder.none,
                              focusedBorder: InputBorder.none,
                              prefixIcon: Padding(
                                padding: const EdgeInsets.only(right: 10),
                                child: Center(
                                  widthFactor: 1,
                                  heightFactor: 1,
                                  child: Text(
                                    'password >',
                                    style: boxMonoStyle(color: Colors.white70),
                                  ),
                                ),
                              ),
                              prefixIconConstraints: const BoxConstraints(
                                minHeight: 36,
                              ),
                              suffixIconConstraints: const BoxConstraints(
                                minWidth: 28,
                                minHeight: 28,
                              ),
                              suffixIcon: IconButton(
                                tooltip: _obscure
                                    ? 'Show password'
                                    : 'Hide password',
                                icon: Icon(
                                  _obscure
                                      ? Icons.visibility_outlined
                                      : Icons.visibility_off_outlined,
                                  size: 16,
                                ),
                                onPressed: _submitting
                                    ? null
                                    : () =>
                                          setState(() => _obscure = !_obscure),
                              ),
                              contentPadding: EdgeInsets.zero,
                            ),
                            // Native Done must keep the prompt's key scope alive
                            // while connecting, so Escape still closes it.
                            onEditingComplete: () {},
                            onSubmitted: (_) => _submit(),
                            onChanged: _edited,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          _submitting
                              ? 'Connecting continues if you close this prompt.'
                              : 'Your previous agent will reconnect automatically after linking.',
                          style: boxMonoStyle(size: 11, color: kBoxFaint),
                        ),
                        const SizedBox(height: 8),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            key: const Key('link-troubleshooting-details'),
                            style: TextButton.styleFrom(
                              textStyle: boxMonoStyle(size: 11),
                              foregroundColor: Colors.white70,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 4,
                              ),
                              minimumSize: const Size(0, 28),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            onPressed: () => setState(
                              () => _showTroubleshootingDetails =
                                  !_showTroubleshootingDetails,
                            ),
                            child: Text(
                              _showTroubleshootingDetails
                                  ? 'Hide details'
                                  : 'Troubleshooting details',
                            ),
                          ),
                        ),
                        if (_showTroubleshootingDetails)
                          SelectableText(
                            'Machine ID: $_machineId',
                            style: boxMonoStyle(size: 11, color: kBoxFaint),
                          ),
                      ],
                    ),
                  ),
                ),
                BoxHintStrip(
                  message: _error ?? (_submitting ? _progress : null),
                  isError: _error != null,
                  hints: [
                    if (!_submitting)
                      BoxHint('enter', 'link machine', onTap: _submit),
                    BoxHint('tab', 'controls'),
                    BoxHint('esc', 'close', onTap: _close),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
