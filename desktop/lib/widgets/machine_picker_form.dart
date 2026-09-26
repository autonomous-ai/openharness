import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../auth/cli_link.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../state/app_state.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'link_another_machine_dialog.dart'
    show
        kHarnessDownloadUrl,
        kLinkServerInstallCommand,
        kLinkServerLoginCommand,
        kLinkServerStartCommand;
import 'terminal_text_action.dart';

enum MachinePickerFormKind { connect, rename, password, delete, app, cli }

/// An editor in the resource preview, not another route or machine picker.
/// Pending writes belong to AppNotifier and survive leaving this editor.
class MachinePickerForm extends StatefulWidget {
  const MachinePickerForm({
    super.key,
    required this.app,
    required this.kind,
    required this.onClose,
    required this.onFocusChanged,
    this.onSwitchPane,
    this.machineId,
  });
  final AppNotifier app;
  final MachinePickerFormKind kind;
  final String? machineId;
  final ValueChanged<String?> onClose;
  final ValueChanged<bool> onFocusChanged;
  final VoidCallback? onSwitchPane;

  @override
  State<MachinePickerForm> createState() => MachinePickerFormState();
}

class MachinePickerFormState extends State<MachinePickerForm> {
  final _scope = FocusNode(debugLabel: 'Machine editor');
  final _input = FocusNode(debugLabel: 'Machine value');
  final _confirmation = FocusNode(debugLabel: 'Confirm password');
  final _buttons = <String, FocusNode>{};
  final _value = TextEditingController();
  final _confirm = TextEditingController();
  RemotePasswordStatus? _passwordStatus;
  bool _busy = false, _loading = false, _editingPassword = false;
  bool _clearConfirmation = false, _showPassword = false;
  String? _message;
  bool _error = false;
  int _clipboardRevision = 0;

  AppNotifier get app => widget.app;
  MachineState? get machine => app.stateOf(widget.machineId ?? '');
  bool get _password => widget.kind == MachinePickerFormKind.password;
  bool get _setup =>
      widget.kind == MachinePickerFormKind.app ||
      widget.kind == MachinePickerFormKind.cli;
  bool get _hasInput =>
      widget.kind == MachinePickerFormKind.rename ||
      widget.kind == MachinePickerFormKind.connect ||
      (_password && _editingPassword && !_clearConfirmation && !_loading);
  bool get _composing => [_value, _confirm].any(
    (controller) =>
        controller.value.composing.isValid &&
        !controller.value.composing.isCollapsed,
  );

  @override
  void initState() {
    super.initState();
    if (widget.kind == MachinePickerFormKind.rename) {
      _value.text =
          app.pendingMachineName(widget.machineId!) ??
          machine?.machine.displayName ??
          '';
      _value.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _value.text.length,
      );
    }
    final pending = switch (widget.kind) {
      MachinePickerFormKind.connect => app.pendingMachineLink(
        widget.machineId!,
      ),
      MachinePickerFormKind.rename => app.pendingMachineRename(
        widget.machineId!,
      ),
      MachinePickerFormKind.delete => app.pendingMachineDelete(
        widget.machineId!,
      ),
      _ => null,
    };
    if (pending != null) {
      _busy = true;
      unawaited(_finish(pending));
    } else if (_password) {
      if (app.pendingRemotePasswordChange case final pending?) {
        _busy = true;
        _clearConfirmation = app.clearingRemotePassword;
        unawaited(_finish(pending.then((status) => status.error)));
      } else {
        unawaited(_loadPassword());
      }
    }
    focus();
  }

  @override
  void dispose() {
    _scope.dispose();
    _input.dispose();
    _confirmation.dispose();
    for (final node in _buttons.values) {
      node.dispose();
    }
    _value.dispose();
    _confirm.dispose();
    super.dispose();
  }

  FocusNode get _focusTarget => _hasInput && !_busy
      ? _input
      : _buttons[widget.kind == MachinePickerFormKind.delete || _busy
                ? 'Cancel'
                : _actions.firstOrNull?.label] ??
            _scope;

  void focus() {
    if (_focusTarget.context != null) {
      _focusTarget.requestFocus();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _focusTarget.requestFocus();
      });
    }
  }

  List<FocusNode> get _nodes => [
    if (_hasInput) _input,
    if (_hasInput && _password) _confirmation,
    for (final action in _actions)
      if (action.run != null && _buttons[_buttonId(action.label)] != null)
        _buttons[_buttonId(action.label)]!,
  ];

  void _move(bool forward, {bool buttonsOnly = false}) {
    if (_composing) return;
    final nodes = _nodes
        .where((node) => !buttonsOnly || _buttons.containsValue(node))
        .toList();
    if (nodes.isEmpty) return;
    final current = nodes.indexWhere((node) => node.hasFocus);
    final index = current < 0
        ? 0
        : (current + (forward ? 1 : -1)) % nodes.length;
    final node = nodes[index];
    node.requestFocus();
    if (node.context case final context?) Scrollable.ensureVisible(context);
  }

  bool handle(String command) {
    if (_composing) return true;
    switch (command) {
      case 'picker.cancel':
        widget.onClose(null);
      case 'picker.accept':
        if (!_scope.hasFocus) {
          focus();
        } else {
          _accept();
        }
      case 'picker.complete':
        _tab(true);
      case 'picker.complete_back':
        _tab(false);
      case 'picker.next' || 'picker.previous':
        if (!_scope.hasFocus) return false;
        _move(command == 'picker.next');
      default:
        return false;
    }
    return true;
  }

  void _tab(bool forward) {
    if (_composing) return;
    widget.onSwitchPane != null ? widget.onSwitchPane!() : _move(forward);
  }

  void _accept() {
    if (_composing) return;
    final action = _actions
        .where((a) => _buttons[_buttonId(a.label)]?.hasFocus == true)
        .firstOrNull;
    if (action != null) {
      action.run?.call();
    } else if (_hasInput && !_busy) {
      if (_password && _input.hasFocus && _value.text.isNotEmpty) {
        _confirmation.requestFocus();
      } else {
        _submit();
      }
    }
  }

  Future<void> _loadPassword() async {
    setState(() {
      _loading = true;
      _message = null;
    });
    final status = await app.remotePasswordStatus();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _passwordStatus = status.error == null ? status : null;
      _editingPassword = status.error == null && !status.hasPassword;
      _message = status.error;
      _error = status.error != null;
    });
    focus();
  }

  void _say(String message, {bool error = true}) {
    setState(() {
      _message = message;
      _error = error;
    });
  }

  void _submit() {
    if (_busy || _loading || _composing || _setup) return;
    if (machine == null || machine!.machine.isShared) {
      _say('This machine is no longer available to manage.');
      return;
    }
    if (widget.kind == MachinePickerFormKind.connect &&
        (machine!.isLocalMachine ||
            !machine!.needsLink ||
            machine!.isOffline)) {
      _say(
        machine!.isOffline
            ? 'This machine is offline.'
            : 'This machine is already connected.',
      );
      return;
    }
    if (_hasInput) {
      if (widget.kind == MachinePickerFormKind.rename
          ? _value.text.trim().isEmpty
          : _value.text.isEmpty) {
        _say(
          widget.kind == MachinePickerFormKind.rename
              ? 'Enter a name.'
              : 'Enter a password.',
        );
        _input.requestFocus();
        return;
      }
      if (widget.kind != MachinePickerFormKind.rename &&
          _value.text.contains(RegExp(r'[\r\n]'))) {
        _say('Use a password on one line.');
        _input.requestFocus();
        return;
      }
      if (_password && _value.text != _confirm.text) {
        _say('Passwords do not match.');
        _confirmation.requestFocus();
        return;
      }
    }
    final request = switch (widget.kind) {
      MachinePickerFormKind.connect => app.connectWithPassword(
        widget.machineId!,
        _value.text,
      ),
      MachinePickerFormKind.rename => app.renameMachine(
        widget.machineId!,
        _value.text.trim(),
      ),
      MachinePickerFormKind.delete => app.deleteMachine(widget.machineId!),
      MachinePickerFormKind.password when machine!.isLocalMachine =>
        _clearConfirmation
            ? app.clearRemotePassword()
            : app.setRemotePassword(_value.text).then((result) => result.error),
      _ => null,
    };
    if (request == null) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    _buttons['Cancel']?.requestFocus();
    unawaited(_finish(request));
  }

  Future<void> _finish(Future<String?> request) async {
    String? error;
    try {
      error = await request;
    } catch (_) {
      error = 'Could not finish. Try again.';
    }
    if (!mounted) return;
    if (error == null) {
      _value.clear();
      _confirm.clear();
      widget.onClose(
        _password
            ? (_clearConfirmation ? 'Password cleared.' : 'Password saved.')
            : null,
      );
      return;
    }
    setState(() {
      _busy = false;
      _message = error;
      _error = true;
    });
    if (_password && _passwordStatus == null) {
      // A reopened request has no password buffer or trusted status yet.
      await _loadPassword();
      if (mounted) _say(error);
    }
    focus();
  }

  Future<void> _copy() async {
    final revision = ++_clipboardRevision;
    final cli = widget.kind == MachinePickerFormKind.cli;
    try {
      await Clipboard.setData(
        ClipboardData(
          text: cli
              ? '$kLinkServerInstallCommand\n$kLinkServerLoginCommand\n$kLinkServerStartCommand'
              : kHarnessDownloadUrl.toString(),
        ),
      );
      if (mounted && revision == _clipboardRevision) {
        _say(
          cli ? 'Copied. Run on the other computer.' : 'Download link copied.',
          error: false,
        );
      }
    } catch (_) {
      if (mounted && revision == _clipboardRevision) {
        _say('Could not copy. Select the text to copy it.');
      }
    }
  }

  Future<void> _download() async {
    try {
      if (await launchUrl(
        kHarnessDownloadUrl,
        mode: LaunchMode.externalApplication,
      )) {
        return;
      }
    } catch (_) {
      /* Keep recovery beside the download link. */
    }
    if (mounted) {
      _say('Could not open the browser. Copy the download link instead.');
    }
  }

  List<({String label, VoidCallback? run})> get _actions {
    void close() => widget.onClose(null);
    if (_setup) {
      return [
        if (widget.kind == MachinePickerFormKind.app)
          (label: 'Download', run: () => unawaited(_download())),
        (label: 'Copy', run: () => unawaited(_copy())),
        (label: 'Back', run: close),
      ];
    }
    if (_password &&
        !_busy &&
        !_loading &&
        !_editingPassword &&
        !_clearConfirmation) {
      if (_passwordStatus == null) {
        return [
          (label: 'Retry', run: () => unawaited(_loadPassword())),
          (label: 'Cancel', run: close),
        ];
      }
      return [
        (
          label: 'Change',
          run: () {
            setState(() {
              _editingPassword = true;
              _message = null;
            });
            focus();
          },
        ),
        (
          label: 'Clear',
          run: () {
            setState(() {
              _clearConfirmation = true;
              _message = null;
            });
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) _buttons['Cancel']?.requestFocus();
            });
          },
        ),
        (label: 'Cancel', run: close),
      ];
    }
    return [
      (
        label: switch (widget.kind) {
          MachinePickerFormKind.connect => 'Connect',
          MachinePickerFormKind.delete => 'Delete',
          _ => _clearConfirmation ? 'Clear' : 'Save',
        },
        run: _busy || _loading ? null : _submit,
      ),
      if (_hasInput && widget.kind != MachinePickerFormKind.rename)
        (
          label: _showPassword ? 'Hide' : 'Show',
          run: () => setState(() => _showPassword = !_showPassword),
        ),
      (label: 'Cancel', run: close),
    ];
  }

  String _buttonId(String label) =>
      label == 'Show' || label == 'Hide' ? 'visibility' : label;

  String get _progress => switch (widget.kind) {
    MachinePickerFormKind.connect => switch (app.machineLinkStage(
      widget.machineId!,
    )) {
      'deriving_key' => 'Checking password…',
      'exchanging' || 'verifying' => 'Verifying the link…',
      _ => 'Connecting…',
    },
    MachinePickerFormKind.delete => 'Deleting…',
    _ => 'Saving…',
  };

  Map<String, VoidCallback> get _keyActions => {
    'picker.accept': _accept,
    'picker.cancel': () => widget.onClose(null),
    'picker.complete': () => _tab(true),
    'picker.complete_back': () => _tab(false),
    'picker.next': () => _move(true),
    'picker.previous': () => _move(false),
  };

  Widget _keys(Widget child, {bool buttons = false}) {
    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        composing: () => _composing,
        actions: {
          ..._keyActions,
          if (buttons) ...{
            'picker.control_next': () => _move(true, buttonsOnly: true),
            'picker.control_previous': () => _move(false, buttonsOnly: true),
          },
        },
        child: child,
      );
    }
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(
          LogicalKeyboardKey.enter,
          includeRepeats: false,
        ): () {
          if (!_composing) _accept();
        },
        const SingleActivator(
          LogicalKeyboardKey.numpadEnter,
          includeRepeats: false,
        ): () {
          if (!_composing) _accept();
        },
        const SingleActivator(LogicalKeyboardKey.escape): () {
          if (!_composing) widget.onClose(null);
        },
        const SingleActivator(LogicalKeyboardKey.tab): () => _tab(true),
        const SingleActivator(LogicalKeyboardKey.tab, shift: true): () =>
            _tab(false),
        const SingleActivator(LogicalKeyboardKey.arrowDown): () => _move(true),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () => _move(false),
        if (buttons) ...{
          const SingleActivator(LogicalKeyboardKey.arrowRight): () =>
              _move(true, buttonsOnly: true),
          const SingleActivator(LogicalKeyboardKey.arrowLeft): () =>
              _move(false, buttonsOnly: true),
        },
      },
      child: child,
    );
  }

  Widget _field(
    String label,
    TextEditingController controller,
    FocusNode focus,
    String key,
  ) {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final cell = terminalCellSizeOf(context);
    return Row(
      children: [
        SizedBox(
          width: cell.width * 10,
          child: Text(
            '$label >',
            style: terminalContentStyle(
              color: theme.foreground.withValues(alpha: .54),
            ),
          ),
        ),
        Expanded(
          child: ReadlineKeys(
            controller: controller,
            enabled: !_busy,
            onChanged: (_) {
              if (_message != null) setState(() => _message = null);
            },
            child: TextField(
              key: ValueKey(key),
              controller: controller,
              focusNode: focus,
              readOnly: _busy,
              onTapOutside: (_) {},
              obscureText:
                  widget.kind != MachinePickerFormKind.rename && !_showPassword,
              enableSuggestions: false,
              autocorrect: false,
              style: terminalContentStyle(color: theme.foreground),
              cursorColor: theme.foreground,
              cursorWidth: 2,
              decoration: const InputDecoration(
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                filled: false,
                isDense: true,
                isCollapsed: true,
                constraints: BoxConstraints(),
                contentPadding: EdgeInsets.zero,
              ),
              onEditingComplete: () {},
              onChanged: (_) {
                if (_message != null) setState(() => _message = null);
              },
            ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    Widget line(String text, {bool selectable = false}) => selectable
        ? SelectableText(
            text,
            style: terminalContentStyle(color: theme.foreground),
          )
        : Text(text, style: terminalContentStyle(color: theme.foreground));
    final gap = SizedBox(height: cell.height);
    final name = machine?.machine.displayName ?? '';
    final email = app.currentUser?.email;
    final body = SingleChildScrollView(
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          line(
            _setup
                ? 'Add machine · ${widget.kind == MachinePickerFormKind.app ? 'App' : 'CLI'}'
                : name,
          ),
          gap,
          if (_setup) ...[
            line('On the other computer:'),
            gap,
            if (widget.kind == MachinePickerFormKind.app) ...[
              line('1. Install Harness for macOS or Linux.'),
              line(kHarnessDownloadUrl.toString(), selectable: true),
              gap,
              line(
                '2. Sign in ${email == null ? 'to the same account' : 'as $email'}.',
              ),
              gap,
              line(
                '3. Set its password in Cmd P → @ → this computer → Password.',
              ),
            ] else ...[
              line('1. Install the CLI (skip if installed).'),
              line(kLinkServerInstallCommand, selectable: true),
              gap,
              line(
                '2. Sign in ${email == null ? 'to the same account' : 'as $email'}.',
              ),
              line(kLinkServerLoginCommand, selectable: true),
              gap,
              line('3. Start Harness and set its password.'),
              line(kLinkServerStartCommand, selectable: true),
            ],
            gap,
            line('Then select the machine here and Connect.'),
          ] else if (widget.kind == MachinePickerFormKind.delete) ...[
            line('Delete this machine from your account?'),
            line('Its panes in this window will close.'),
          ] else if (_clearConfirmation) ...[
            line('Clear this computer’s remote password?'),
            line('New connections will need a password set again.'),
          ] else if (_loading)
            line('Checking password…')
          else if (_password && !_editingPassword) ...[
            if (_passwordStatus != null) line('Password is set.'),
          ] else if (_hasInput) ...[
            if (widget.kind == MachinePickerFormKind.rename)
              line('Rename machine')
            else
              line(
                _password
                    ? 'Set a password for other computers to connect here.'
                    : 'Enter the password set on $name.',
              ),
            gap,
            _field(
              widget.kind == MachinePickerFormKind.rename ? 'name' : 'password',
              _value,
              _input,
              widget.kind == MachinePickerFormKind.rename
                  ? 'machine-rename-input'
                  : _password
                  ? 'remote-password-field'
                  : 'remote-password-connect-field',
            ),
            if (_password) ...[
              gap,
              _field(
                'confirm',
                _confirm,
                _confirmation,
                'remote-password-confirm-field',
              ),
            ],
          ],
          gap,
          if (_busy || _message != null) ...[
            Semantics(
              liveRegion: true,
              child: Text(
                _busy ? _progress : _message!,
                style: terminalContentStyle(
                  color: !_busy && _error
                      ? theme.yellow
                      : theme.foreground.withValues(alpha: .54),
                ),
              ),
            ),
            gap,
          ],
          _keys(
            Wrap(
              spacing: cell.width * 2,
              runSpacing: cell.height,
              children: [
                for (final action in _actions)
                  TerminalTextAction(
                    key: ValueKey('machine-form:${_buttonId(action.label)}'),
                    label: action.label,
                    padding: EdgeInsets.zero,
                    focusNode: _buttons.putIfAbsent(
                      _buttonId(action.label),
                      () => FocusNode(debugLabel: action.label),
                    ),
                    onPressed: action.run,
                  ),
              ],
            ),
            buttons: true,
          ),
        ],
      ),
    );
    String? hint(String command) => effectiveCommandHint(
      context,
      command,
      contextKind: KeymapContext.picker,
    )?.replaceAll('⇥', 'Tab').replaceAll('↵', 'Enter');
    return _keys(
      Focus(
        focusNode: _scope,
        onFocusChange: widget.onFocusChanged,
        onKeyEvent: (_, event) {
          // Do not let the editor's native Enter bypass a deliberate unbinding.
          if (KeymapTheme.of(context) != null &&
              (_input.hasFocus || _confirmation.hasFocus) &&
              (event.logicalKey == LogicalKeyboardKey.enter ||
                  event.logicalKey == LogicalKeyboardKey.numpadEnter)) {
            return _composing
                ? KeyEventResult.skipRemainingHandlers
                : KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: body),
            Padding(
              padding: EdgeInsets.symmetric(
                horizontal: cell.width * 2,
                vertical: cell.height,
              ),
              child: Text(
                [
                  if (hint('picker.accept') case final enter?) '$enter select',
                  if (hint('picker.complete') case final tab?)
                    '$tab ${widget.onSwitchPane != null ? 'pane' : 'next'}',
                  if (hint('picker.cancel') case final escape?) '$escape back',
                ].join('  ·  '),
                style: terminalContentStyle(
                  color: theme.foreground.withValues(alpha: .54),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
