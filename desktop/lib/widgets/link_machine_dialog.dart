import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth/cli_link.dart';
import '../shared/widgets/app_dialog.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart' show describeKeyBinding;
import '../state/app_state.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';

import 'box_chrome.dart';

/// This computer's incoming password and, separately, its outgoing links.
Future<void> showLinkMachineDialog(
  BuildContext context,
  AppNotifier notifier, {
  bool passwordOnly = false,
}) {
  final keymap = KeymapTheme.of(context, listen: false);
  return showAppDialog<void>(
    context: context,
    transitionDuration: Duration.zero,
    veilBlur: 0,
    builder: (_) {
      final dialog = _LinkMachineDialog(
        notifier: notifier,
        passwordOnly: passwordOnly,
      );
      return keymap == null
          ? dialog
          : KeymapProvider(keymap: keymap, child: dialog);
    },
  );
}

enum _Page { password, clear, links, unlink }

class _LinkMachineDialog extends StatefulWidget {
  const _LinkMachineDialog({
    required this.notifier,
    required this.passwordOnly,
  });
  final AppNotifier notifier;
  final bool passwordOnly;
  @override
  State<_LinkMachineDialog> createState() => _LinkMachineDialogState();
}

class _LinkMachineDialogState extends State<_LinkMachineDialog> {
  AppNotifier get app => widget.notifier;
  final _password = TextEditingController();
  final _confirm = TextEditingController();
  final _passwordFocus = FocusNode(debugLabel: 'New remote password');
  final _confirmFocus = FocusNode(debugLabel: 'Confirm remote password');
  final _actionFocus = FocusNode(debugLabel: 'Password prompt action');
  final _announcer = BoxAnnouncer();
  _Page _page = _Page.password;
  RemotePasswordStatus? _status;
  LinkedMachine? _unlinkTarget;
  bool _loading = true, _editing = false, _obscure = true;
  bool _busy = false, _clearing = false;
  String? _message;
  bool _error = false;

  bool get _composing =>
      _page == _Page.password &&
      _editing &&
      [_password, _confirm].any(
        (controller) =>
            controller.value.composing.isValid &&
            !controller.value.composing.isCollapsed,
      );
  bool get _mac => Theme.of(context).platform == TargetPlatform.macOS;

  @override
  void initState() {
    super.initState();
    if (app.pendingRemotePasswordChange case final pending?) {
      _loading = false;
      _busy = true;
      _clearing = app.clearingRemotePassword;
      unawaited(_finishChange(pending));
    } else {
      unawaited(_loadStatus());
    }
  }

  @override
  void dispose() {
    _password.dispose();
    _confirm.dispose();
    _passwordFocus.dispose();
    _confirmFocus.dispose();
    _actionFocus.dispose();
    super.dispose();
  }

  void _focus([FocusNode? node]) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || ModalRoute.of(context)?.isCurrent == false) return;
      (node ??
              (_page == _Page.password && _editing && !_busy
                  ? _passwordFocus
                  : _actionFocus))
          .requestFocus();
    });
  }

  void _say(String? message, {bool error = false}) {
    setState(() {
      _message = message;
      _error = error;
    });
    _announcer.row(context, message);
  }

  Future<void> _loadStatus() async {
    if (_busy) return;
    setState(() {
      _loading = true;
      _message = null;
      _error = false;
    });
    final status = await app.remotePasswordStatus();
    if (!mounted) return;
    setState(() {
      _loading = false;
      if (status.error == null) {
        _status = status;
        _editing = !status.hasPassword;
      }
    });
    if (status.error != null) _say(status.error, error: true);
    _focus();
  }

  void _edit() {
    if (_busy) return;
    setState(() {
      _editing = true;
      _message = null;
      _obscure = true;
    });
    _focus(_passwordFocus);
  }

  void _edited(String _) {
    if (_message != null) _say(null);
  }

  void _nextField() {
    if (_busy || _composing) return;
    if (_password.text.isEmpty) {
      _say('Enter a password', error: true);
    } else {
      _confirmFocus.requestFocus();
    }
  }

  void _submit() {
    if (_busy ||
        _loading ||
        _composing ||
        _page != _Page.password ||
        !_editing) {
      return;
    }
    if (_password.text.isEmpty) {
      _say('Enter a password', error: true);
      _passwordFocus.requestFocus();
      return;
    }
    if (_password.text != _confirm.text) {
      _say('Passwords do not match', error: true);
      _confirmFocus.requestFocus();
      return;
    }
    // The CLI reads one line from stdin. Never silently accept a truncated
    // paste that would set a different password from the one shown here.
    if (_password.text.contains(RegExp(r'[\r\n]'))) {
      _say('Use a password on one line', error: true);
      _passwordFocus.requestFocus();
      return;
    }
    setState(() {
      _busy = true;
      _clearing = false;
      _message = null;
    });
    final request = app.setRemotePassword(_password.text);
    unawaited(
      _finishChange(
        request.then(
          (result) => RemotePasswordStatus(
            error: result.error,
            hasPassword: result.error == null,
            fingerprint: result.fingerprint,
            setAt: result.error == null ? DateTime.now() : null,
          ),
        ),
      ),
    );
  }

  Future<void> _finishChange(Future<RemotePasswordStatus> request) async {
    final result = await request;
    if (!mounted) return;
    final cleared = _clearing;
    setState(() {
      _busy = false;
      _page = _Page.password;
      if (result.error == null) {
        _status = result;
        _editing = !result.hasPassword;
        _password.clear();
        _confirm.clear();
        _obscure = true;
      }
    });
    _say(
      result.error ?? (cleared ? 'Password cleared.' : 'Password set.'),
      error: result.error != null,
    );
    // A reopened failed operation has no local status or password buffer.
    // Read status before offering a retry; never show "not set" on failure.
    if (result.error != null && _status == null) {
      final status = await app.remotePasswordStatus();
      if (!mounted) return;
      if (status.error == null) {
        setState(() {
          _status = status;
          _editing = !status.hasPassword;
        });
      }
    }
    _focus(result.error != null && _editing ? _confirmFocus : null);
  }

  void _askClear() {
    if (_busy) return;
    setState(() {
      _page = _Page.clear;
      _message = null;
    });
    _focus(); // Cancel owns Enter until the user chooses Clear.
  }

  void _clear() {
    if (_busy) return;
    setState(() {
      _busy = true;
      _clearing = true;
      _message = null;
    });
    unawaited(
      _finishChange(
        app.clearRemotePassword().then(
          (error) => RemotePasswordStatus(error: error),
        ),
      ),
    );
  }

  void _links() {
    if (_busy) return;
    setState(() {
      _page = _Page.links;
      _message = null;
    });
    unawaited(app.refreshLinkedMachines());
    _focus();
  }

  void _askUnlink(LinkedMachine machine) {
    setState(() {
      _page = _Page.unlink;
      _unlinkTarget = machine;
      _message = null;
    });
    _focus();
  }

  Future<void> _unlink() async {
    final machine = _unlinkTarget;
    if (_busy || machine == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    final error = await app.unlinkMachine(machine.machineId);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (error == null) _page = _Page.links;
    });
    final refreshError = app.linkedMachinesError;
    _say(
      error ??
          '${_name(machine)} unlinked.${refreshError == null ? '' : ' $refreshError'}',
      error: error != null || refreshError != null,
    );
    _focus();
  }

  String _name(LinkedMachine machine) =>
      app.stateOf(machine.machineId)?.machine.displayName ?? machine.machineId;

  void _back() {
    if (_composing) return;
    if (_busy ||
        _page == _Page.password && !_editing ||
        _page == _Page.password && _status?.hasPassword != true) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _message = null;
      if (_page == _Page.unlink) {
        _page = _Page.links;
      } else if (_page != _Page.password) {
        _page = _Page.password;
      } else {
        _editing = false;
        _password.clear();
        _confirm.clear();
        _obscure = true;
      }
    });
    _focus();
  }

  void _accept() {
    if (_composing) return;
    if (_page == _Page.password && _editing && _passwordFocus.hasFocus) {
      _nextField();
    } else if (_page == _Page.password && _editing && _confirmFocus.hasFocus) {
      _submit();
    } else if (FocusManager.instance.primaryFocus?.context case final target?) {
      Actions.maybeInvoke(target, const ActivateIntent());
    }
  }

  void _refresh() {
    if (_busy || _loading) return;
    if (_page == _Page.links) {
      if (app.linkedMachinesLoading) return;
      _say(null);
      unawaited(app.refreshLinkedMachines());
    } else if (_page == _Page.password && !_editing) {
      unawaited(_loadStatus());
    }
  }

  String _hint(String command, String fallback) {
    final map = KeymapTheme.of(context);
    if (map == null) return fallback;
    final bindings = map
        .bindings(command, context: KeymapContext.picker)
        .toList();
    final binding =
        bindings.where((b) => b.custom).firstOrNull ??
        (command == 'picker.refresh' && !_mac
            ? bindings
                  .where((b) => b.keys.length == 1 && b.keys.first.control)
                  .firstOrNull
            : null) ??
        bindings.firstOrNull;
    return binding == null ? 'click' : describeKeyBinding(binding);
  }

  Widget _keys(Widget child) {
    if (KeymapTheme.of(context) == null) return child;
    return KeymapRegion(
      contextKind: KeymapContext.picker,
      composing: () => _composing,
      actions: {
        'picker.accept': _accept,
        'picker.add_here': _accept,
        'picker.cancel': _back,
        'picker.refresh': _refresh,
        'picker.next': () => FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.previous': () =>
            FocusManager.instance.primaryFocus?.previousFocus(),
        'picker.complete': () =>
            FocusManager.instance.primaryFocus?.nextFocus(),
        'picker.complete_back': () =>
            FocusManager.instance.primaryFocus?.previousFocus(),
      },
      child: Actions(
        actions: {
          DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) => null),
        },
        child: child,
      ),
    );
  }

  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    final enter =
        event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter;
    final escape = event.logicalKey == LogicalKeyboardKey.escape;
    if (_composing && (enter || escape)) {
      return KeyEventResult.skipRemainingHandlers;
    }
    if (KeymapTheme.of(context, listen: false) != null) {
      // Do not let TextField's native submit bypass an unbound accept key.
      return enter &&
              _page == _Page.password &&
              _editing &&
              (_passwordFocus.hasFocus || _confirmFocus.hasFocus)
          ? KeyEventResult.handled
          : KeyEventResult.ignored;
    }
    if (keyboard.isAltPressed || keyboard.isShiftPressed) {
      return KeyEventResult.ignored;
    }
    if (keyboard.isMetaPressed || keyboard.isControlPressed) {
      if (event.logicalKey == LogicalKeyboardKey.keyR &&
          (_mac ? keyboard.isMetaPressed : keyboard.isControlPressed)) {
        _refresh();
        return KeyEventResult.handled;
      }
      if (keyboard.isControlPressed &&
          event.logicalKey == LogicalKeyboardKey.keyC) {
        _back();
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (escape) {
      _back();
      return KeyEventResult.handled;
    }
    if (enter &&
        _page == _Page.password &&
        _editing &&
        (_passwordFocus.hasFocus || _confirmFocus.hasFocus)) {
      // A held Enter cannot advance and then submit on a key repeat.
      if (event is KeyDownEvent) _accept();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Widget _button(
    String label,
    VoidCallback? action, {
    Key? key,
    bool first = false,
    bool danger = false,
    bool primary = false,
  }) {
    if (primary || danger) {
      return FilledButton(
        key: key,
        focusNode: first ? _actionFocus : null,
        onPressed: action,
        style: danger ? grid.dangerButtonStyle() : null,
        child: Text(label),
      );
    }
    return TextButton(
      key: key,
      focusNode: first ? _actionFocus : null,
      onPressed: action,
      child: Text(label),
    );
  }

  Widget _field({required bool confirm}) {
    final controller = confirm ? _confirm : _password;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            confirm ? 'Confirm password' : 'Remote password',
            style: DesktopChrome.control(medium: true),
          ),
          const SizedBox(height: 6),
          Tooltip(
            message:
                '${confirm ? 'Set password' : 'Confirm password'} · ${_hint('picker.accept', 'enter')}',
            child: ReadlineKeys(
              controller: controller,
              enabled: !_busy,
              onChanged: _edited,
              child: TextField(
                key: Key(
                  confirm
                      ? 'remote-password-confirm-field'
                      : 'remote-password-field',
                ),
                controller: controller,
                focusNode: confirm ? _confirmFocus : _passwordFocus,
                readOnly: _busy,
                obscureText: _obscure,
                enableSuggestions: false,
                autocorrect: false,
                style: DesktopChrome.text(),
                textAlignVertical: TextAlignVertical.center,
                textInputAction: confirm
                    ? TextInputAction.done
                    : TextInputAction.next,
                decoration: InputDecoration(
                  hintText: confirm ? 'Repeat password' : 'New remote password',
                  hintStyle: DesktopChrome.text(color: DesktopChrome.muted),
                  suffixIconConstraints: const BoxConstraints(
                    minWidth: 40,
                    minHeight: 36,
                  ),
                  suffixIcon: confirm
                      ? null
                      : Center(
                          widthFactor: 1,
                          heightFactor: 1,
                          child: IconButton(
                            tooltip: _obscure
                                ? 'Show password'
                                : 'Hide password',
                            icon: Icon(
                              _obscure ? AppIcons.eye : AppIcons.eyeOff,
                              size: 16,
                            ),
                            constraints: const BoxConstraints.tightFor(
                              width: 32,
                              height: 32,
                            ),
                            style: ButtonStyle(
                              side: WidgetStateProperty.resolveWith(
                                (states) => BorderSide(
                                  width: 1.5,
                                  color: states.contains(WidgetState.focused)
                                      ? DesktopChrome.accent
                                      : Colors.transparent,
                                ),
                              ),
                            ),
                            onPressed: _busy
                                ? null
                                : () => setState(() => _obscure = !_obscure),
                          ),
                        ),
                ),
                onEditingComplete: () {},
                onSubmitted: (_) => confirm ? _submit() : _nextField(),
                onChanged: _edited,
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _passwordBody() {
    if (_loading) {
      return [
        Text('Reading password status…', style: DesktopChrome.metadata()),
      ];
    }
    if (_status == null) {
      return [
        Text(
          _busy
              ? 'This operation continues if you close the prompt.'
              : 'Password status is unavailable.',
          style: DesktopChrome.metadata(),
        ),
        if (!_busy)
          Align(
            alignment: Alignment.centerLeft,
            child: _button(
              'Retry',
              () => unawaited(_loadStatus()),
              first: true,
            ),
          ),
      ];
    }
    return [
      if (_editing) ...[
        Text(
          'Use this password on the other machine to link to this computer.',
          style: DesktopChrome.text(color: DesktopChrome.muted),
        ),
        const SizedBox(height: 12),
        _field(confirm: false),
        _field(confirm: true),
      ] else ...[
        Text('Remote password is set', style: DesktopChrome.text(medium: true)),
        const SizedBox(height: 8),
        Text(
          'On the other machine: Link machine → select this computer → enter its password.',
          style: DesktopChrome.text(color: DesktopChrome.muted),
        ),
        if (_status!.fingerprint case final fingerprint?) ...[
          const SizedBox(height: 12),
          Text('Fingerprint', style: DesktopChrome.metadata()),
          SelectableText(
            fingerprint,
            style: grid.AppType.mono(color: DesktopChrome.muted),
          ),
        ],
        if (_status!.setAt case final date?)
          Text(
            'Set ${date.toLocal().toIso8601String().substring(0, 16).replaceFirst('T', ' ')}',
            style: DesktopChrome.metadata(),
          ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _button(
              'Change password',
              _busy ? null : _edit,
              key: const Key('remote-password-change-button'),
              first: true,
            ),
            _button(
              'Clear password…',
              _busy ? null : _askClear,
              key: const Key('remote-password-clear-button'),
            ),
          ],
        ),
      ],
      if (_busy) ...[
        const SizedBox(height: 8),
        Text(
          'This operation continues if you close the prompt.',
          style: DesktopChrome.metadata(),
        ),
      ],
      if (!widget.passwordOnly) ...[
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerLeft,
          child: _button(
            'Links from this computer…',
            _busy ? null : _links,
            key: const Key('remote-password-links-button'),
          ),
        ),
      ],
    ];
  }

  List<Widget> _linksBody() => [
    Text(
      'Machines this computer can connect to.',
      style: DesktopChrome.text(color: DesktopChrome.muted),
    ),
    const SizedBox(height: 8),
    Align(
      alignment: Alignment.centerLeft,
      child: _button('Refresh links', _refresh, first: true),
    ),
    if (app.linkedMachinesLoading && app.linkedMachines.isEmpty)
      Text('Loading linked machines…', style: DesktopChrome.metadata())
    else if (app.linkedMachines.isEmpty && app.linkedMachinesError == null)
      Text('No machines linked yet.', style: DesktopChrome.metadata()),
    for (final machine in app.linkedMachines)
      Padding(
        padding: const EdgeInsets.only(top: 12, bottom: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_name(machine), style: DesktopChrome.text()),
            SelectableText(
              machine.fingerprint,
              style: grid.AppType.mono(color: DesktopChrome.muted),
            ),
            Text('Linked ${machine.linkedAt}', style: DesktopChrome.metadata()),
            _button(
              app.unlinkingMachine(machine.machineId)
                  ? 'Unlinking…'
                  : 'Unlink…',
              app.unlinkingMachine(machine.machineId)
                  ? null
                  : () => _askUnlink(machine),
              key: ValueKey('unlink-${machine.machineId}'),
            ),
          ],
        ),
      ),
  ];

  List<Widget> _confirmationBody() {
    final clear = _page == _Page.clear;
    return [
      Text(
        clear
            ? 'Prevent new links using this password? Existing links and sessions stay connected.'
            : 'Remove this computer’s saved link to ${_name(_unlinkTarget!)}? A new connection will need that machine’s password.',
        style: DesktopChrome.text(color: DesktopChrome.muted),
      ),
    ];
  }

  List<Widget> _dialogActions() {
    if (_busy) {
      return [TextButton(onPressed: _back, child: const Text('Close'))];
    }
    if (_page == _Page.clear || _page == _Page.unlink) {
      final clear = _page == _Page.clear;
      return [
        _button('Cancel', _back, first: true),
        _button(
          clear ? 'Clear password' : 'Unlink',
          clear ? _clear : () => unawaited(_unlink()),
          danger: true,
          key: Key(
            clear
                ? 'remote-password-clear-confirm-button'
                : 'remote-password-unlink-confirm-button',
          ),
        ),
      ];
    }
    if (_page == _Page.password && _editing && _status != null) {
      return [
        _button(_status!.hasPassword ? 'Cancel' : 'Close', _back),
        _button(
          _status!.hasPassword ? 'Change password' : 'Set password',
          _submit,
          key: const Key('remote-password-set-button'),
          primary: true,
        ),
      ];
    }
    final close = _page == _Page.password;
    return [
      Tooltip(
        message:
            '${close ? 'Close' : 'Back'} · ${_hint('picker.cancel', 'esc')}',
        child: TextButton(
          onPressed: _back,
          child: Text(close ? 'Close' : 'Back'),
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([app, _passwordFocus, _confirmFocus]),
      builder: (context, _) {
        final message = _busy
            ? (_page == _Page.unlink
                  ? 'Unlinking machine…'
                  : _clearing
                  ? 'Clearing password…'
                  : 'Setting password…')
            : _message ??
                  (_page == _Page.links ? app.linkedMachinesError : null);
        final isError =
            !_busy &&
            (_error || _page == _Page.links && app.linkedMachinesError != null);
        return _keys(
          Focus(
            skipTraversal: true,
            autofocus: true,
            onKeyEvent: _key,
            child: DesktopPromptSurface(
              width: 480,
              body: DesktopPromptScrollBody(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Semantics(
                      header: true,
                      child: Text(switch (_page) {
                        _Page.password => 'This computer’s password',
                        _Page.clear => 'Clear remote password',
                        _Page.links => 'Links from this computer',
                        _Page.unlink => 'Unlink machine',
                      }, style: DesktopChrome.heading()),
                    ),
                    const SizedBox(height: 16),
                    ...switch (_page) {
                      _Page.password => _passwordBody(),
                      _Page.links => _linksBody(),
                      _Page.clear || _Page.unlink => _confirmationBody(),
                    },
                  ],
                ),
              ),
              footer: message == null
                  ? null
                  : Semantics(
                      liveRegion: true,
                      child: SelectableText(
                        message,
                        minLines: 1,
                        maxLines: 3,
                        style: DesktopChrome.control(
                          color: isError
                              ? Theme.of(context).colorScheme.error
                              : DesktopChrome.muted,
                        ),
                      ),
                    ),
              actions: _dialogActions(),
            ),
          ),
        );
      },
    );
  }
}
