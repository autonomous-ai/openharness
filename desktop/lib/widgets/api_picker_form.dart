import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/api_connections_controller.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'terminal_text_action.dart';

/// API setup uses the same preview, keymap, and controller as the model list.
/// Secret text belongs only to this editor and is cleared when it closes.
class ApiPickerForm extends StatefulWidget {
  const ApiPickerForm({
    super.key,
    required this.controller,
    required this.onClose,
    required this.onFocusChanged,
    this.onSwitchPane,
    this.connectionId,
    this.removing = false,
  });
  final ApiConnectionsController controller;
  final String? connectionId;
  final bool removing;
  final ValueChanged<String?> onClose;
  final ValueChanged<bool> onFocusChanged;
  final VoidCallback? onSwitchPane;

  @override
  State<ApiPickerForm> createState() => ApiPickerFormState();
}

class ApiPickerFormState extends State<ApiPickerForm> {
  final _scope = FocusNode(debugLabel: 'API editor');
  final _fields = <String, TextEditingController>{};
  final _inputs = <String, FocusNode>{};
  final _buttons = <String, FocusNode>{};
  ApiConnection? _editing;
  bool _advanced = false, _visible = false;
  String? _error;
  ApiConnectionsController get controller => widget.controller;
  bool get _existing => _editing?.id.isNotEmpty == true;
  bool get _enabled => controller.available && !controller.saving;
  bool get _composing => _fields.values.any(
    (field) =>
        field.value.composing.isValid && !field.value.composing.isCollapsed,
  );

  @override
  void initState() {
    super.initState();
    final existing = controller.connections
        .where((row) => row.id == widget.connectionId)
        .firstOrNull;
    if (existing != null) _setConnection(existing);
    if (!controller.loaded && !controller.loading) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !controller.loaded && !controller.loading) {
          unawaited(controller.refresh());
        }
      });
    }
    focus();
  }

  void _setConnection(ApiConnection connection) {
    final preset = controller.presets
        .where((row) => row.provider == connection.provider)
        .firstOrNull;
    _editing = ApiConnection({...?preset?.data, ...connection.data});
    var name = connection.name;
    if (connection.id.isEmpty) {
      var suffix = 2;
      while (controller.connections.any(
        (row) => row.name.toLowerCase() == name.toLowerCase(),
      )) {
        name = '${connection.name} ${suffix++}';
      }
      if (connection.provider == 'custom') name = '';
    }
    for (final entry in {
      'name': name,
      'url': _editing!.baseUrl,
      'key': '',
      'environment': _editing!.keyEnv,
      'header': _editing!.authHeader,
      'prefix': _editing!.authPrefix,
    }.entries) {
      _fields.putIfAbsent(entry.key, TextEditingController.new).text =
          entry.value;
      _inputs.putIfAbsent(
        entry.key,
        () => FocusNode(debugLabel: 'API ${entry.key}'),
      );
    }
    _advanced = false;
    _visible = false;
    _error = null;
  }

  void _choose(ApiConnection connection) {
    if (!_enabled) return;
    setState(() => _setConnection(connection));
    focus();
  }

  List<String> get _visibleFields => _editing == null || widget.removing
      ? []
      : [
          if (_editing!.provider == 'custom' || _advanced) ...['name', 'url'],
          'key',
          if (_advanced) ...['environment', 'header', 'prefix'],
        ];

  List<({String id, String label, VoidCallback? run})> get _actions {
    if (widget.removing) {
      return [
        (id: 'delete', label: 'Delete', run: _enabled ? _remove : null),
        (id: 'cancel', label: 'Cancel', run: () => widget.onClose(null)),
      ];
    }
    if (_editing == null) {
      return [
        for (final preset in controller.presets.where(
          (row) => row.provider != 'openai' && row.provider != 'anthropic',
        ))
          (
            id: 'provider:${preset.provider}',
            label: preset.name,
            run: _enabled ? () => _choose(preset) : null,
          ),
        (
          id: 'provider:custom',
          label: 'Custom API',
          run: _enabled
              ? () => _choose(
                  const ApiConnection({
                    'provider': 'custom',
                    'name': 'Custom API',
                  }),
                )
              : null,
        ),
        if (controller.error != null)
          (
            id: 'retry',
            label: 'Retry',
            run: controller.loading
                ? null
                : () => unawaited(controller.refresh()),
          ),
        (id: 'cancel', label: 'Cancel', run: () => widget.onClose(null)),
      ];
    }
    return [
      (id: 'save', label: 'Save', run: _enabled ? _save : null),
      (
        id: 'visibility',
        label: _visible ? 'Hide' : 'Show',
        run: () => setState(() => _visible = !_visible),
      ),
      (
        id: 'options',
        label: 'Options',
        run: () => setState(() => _advanced = !_advanced),
      ),
      if (_editing!.keyUrl != null)
        (id: 'key-page', label: 'Get key', run: _openKeyPage),
      if (!_existing)
        (
          id: 'back',
          label: 'Back',
          run: () {
            setState(() {
              _fields['key']?.clear();
              _editing = null;
              _error = null;
            });
            focus();
          },
        ),
      (id: 'cancel', label: 'Cancel', run: () => widget.onClose(null)),
    ];
  }

  List<FocusNode> get _nodes => [
    for (final id in _visibleFields) _inputs[id]!,
    for (final action in _actions)
      if (action.run != null && _buttons[action.id] != null)
        _buttons[action.id]!,
  ];

  FocusNode get _focusTarget =>
      (widget.removing ? _buttons['cancel'] : _nodes.firstOrNull) ?? _scope;

  void focus() {
    if (_focusTarget.context != null) {
      _focusTarget.requestFocus();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _focusTarget.requestFocus();
      });
    }
  }

  void _move(bool forward, {bool buttonsOnly = false}) {
    if (_composing) return;
    final nodes = _nodes
        .where((node) => !buttonsOnly || _buttons.containsValue(node))
        .toList();
    if (nodes.isEmpty) return;
    final current = nodes.indexWhere((node) => node.hasFocus);
    final next = current < 0
        ? 0
        : (current + (forward ? 1 : -1)) % nodes.length;
    nodes[next].requestFocus();
    if (nodes[next].context case final context?) {
      Scrollable.ensureVisible(context);
    }
  }

  bool handle(String command) {
    if (_composing) return true;
    switch (command) {
      case 'picker.cancel':
        widget.onClose(null);
      case 'picker.accept':
        _scope.hasFocus ? _accept() : focus();
      case 'picker.complete':
        widget.onSwitchPane != null ? widget.onSwitchPane!() : _move(true);
      case 'picker.complete_back':
        widget.onSwitchPane != null ? widget.onSwitchPane!() : _move(false);
      case 'picker.next':
        if (!_scope.hasFocus) return false;
        _move(true);
      case 'picker.previous':
        if (!_scope.hasFocus) return false;
        _move(false);
      default:
        return false;
    }
    return true;
  }

  void _accept() {
    if (_composing) return;
    final action = _actions
        .where((a) => _buttons[a.id]?.hasFocus == true)
        .firstOrNull;
    if (action != null) {
      action.run?.call();
    } else if (_editing != null && !widget.removing) {
      unawaited(_save());
    }
  }

  Future<void> _save() async {
    if (!_enabled || _composing) return;
    final url = Uri.tryParse(_fields['url']!.text.trim());
    final invalid = _fields['name']!.text.trim().isEmpty
        ? 'Enter a name.'
        : url == null ||
              !['http', 'https'].contains(url.scheme) ||
              url.host.isEmpty ||
              url.userInfo.isNotEmpty ||
              url.hasQuery ||
              url.hasFragment
        ? 'Enter an API URL without credentials or query parameters.'
        : !_existing && _fields['key']!.text.trim().isEmpty
        ? 'Enter an API key.'
        : _fields['header']!.text.trim().isEmpty
        ? 'Enter an authentication header.'
        : null;
    if (invalid != null) {
      setState(() => _error = invalid);
      return;
    }
    final editing = _editing!;
    if (_existing &&
        !controller.connections.any((row) => row.id == editing.id)) {
      setState(() => _error = 'This API was removed. Return to the list.');
      return;
    }
    setState(() => _error = null);
    final name = _fields['name']!.text.trim();
    final saved = await controller.save({
      if (_existing) 'id': editing.id,
      'provider': editing.provider,
      'name': name,
      'baseUrl': _fields['url']!.text.trim(),
      'keyEnv': _fields['environment']!.text.trim(),
      'authHeader': _fields['header']!.text.trim(),
      'authPrefix': _fields['prefix']!.text,
      'apiKey': _fields['key']!.text,
    });
    if (!mounted || !saved) return;
    _fields['key']!.clear();
    final id = controller.connections
        .where((row) => row.name == name)
        .firstOrNull
        ?.id;
    widget.onClose(id);
  }

  Future<void> _remove() async {
    if (!_enabled || _editing == null) return;
    if (await controller.remove(_editing!.id) && mounted) widget.onClose('');
  }

  Future<void> _openKeyPage() async {
    try {
      final opened = await launchUrl(
        Uri.parse(_editing!.keyUrl!),
        mode: LaunchMode.externalApplication,
      );
      if (!opened && mounted) {
        setState(() => _error = 'Could not open the browser. Try again.');
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not open the browser. Try again.');
      }
    }
  }

  Widget _keys(Widget child, {bool buttons = false}) {
    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        composing: () => _composing,
        actions: {
          for (final command in [
            'picker.accept',
            'picker.cancel',
            'picker.complete',
            'picker.complete_back',
            'picker.next',
            'picker.previous',
          ])
            command: () => handle(command),
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
        ): () =>
            handle('picker.accept'),
        const SingleActivator(LogicalKeyboardKey.escape): () =>
            handle('picker.cancel'),
        const SingleActivator(LogicalKeyboardKey.tab): () =>
            handle('picker.complete'),
        const SingleActivator(LogicalKeyboardKey.tab, shift: true): () =>
            handle('picker.complete_back'),
        const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
            handle('picker.next'),
        const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
            handle('picker.previous'),
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

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final style = terminalContentStyle(color: theme.foreground);
    final muted = terminalContentStyle(
      color: theme.foreground.withValues(alpha: .54),
    );
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => _keys(
        Focus(
          focusNode: _scope,
          onFocusChange: widget.onFocusChanged,
          onKeyEvent: (_, event) {
            if (KeymapTheme.of(context) != null &&
                _inputs.values.any((node) => node.hasFocus) &&
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
              Expanded(
                child: SingleChildScrollView(
                  padding: EdgeInsets.symmetric(
                    horizontal: cell.width * 2,
                    vertical: cell.height,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.removing
                            ? 'Delete ${_editing?.name ?? 'API'}?'
                            : _editing?.name ?? 'Add API',
                        style: style,
                      ),
                      SizedBox(height: cell.height),
                      if (_editing != null &&
                          !widget.removing &&
                          _editing!.provider != 'custom')
                        Text(_editing!.baseUrl, style: muted),
                      if (widget.removing)
                        Text(
                          'Remove this saved connection and key?',
                          style: style,
                        ),
                      if (controller.loading && !controller.saving)
                        Text('Loading APIs…', style: muted),
                      for (final id in _visibleFields)
                        Padding(
                          padding: EdgeInsets.only(bottom: cell.height),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(switch (id) {
                                'url' => 'URL',
                                'key' =>
                                  _existing
                                      ? 'Key (blank keeps saved key)'
                                      : 'Key',
                                'environment' => 'Key environment variable',
                                'header' => 'Authentication header',
                                'prefix' => 'Key prefix',
                                _ => 'Name',
                              }, style: muted),
                              ReadlineKeys(
                                controller: _fields[id]!,
                                enabled: !controller.saving,
                                onChanged: (_) {
                                  if (_error != null) {
                                    setState(() => _error = null);
                                  }
                                },
                                child: TextField(
                                  key: ValueKey('api-form-input:$id'),
                                  controller: _fields[id],
                                  focusNode: _inputs[id],
                                  readOnly: controller.saving,
                                  onTapOutside: (_) {},
                                  obscureText: id == 'key' && !_visible,
                                  autocorrect: false,
                                  enableSuggestions: false,
                                  style: style,
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
                                    if (_error != null) {
                                      setState(() => _error = null);
                                    }
                                  },
                                ),
                              ),
                            ],
                          ),
                        ),
                      if (_editing != null && !widget.removing) ...[
                        Text('Stored on this computer.', style: muted),
                        SizedBox(height: cell.height),
                      ],
                      if (_error ?? controller.error case final error?) ...[
                        Text(
                          error,
                          style: terminalContentStyle(color: theme.yellow),
                        ),
                        SizedBox(height: cell.height),
                      ],
                      if (controller.saving) ...[
                        Text('Saving…', style: muted),
                        SizedBox(height: cell.height),
                      ],
                      _keys(
                        Wrap(
                          direction: _editing == null
                              ? Axis.vertical
                              : Axis.horizontal,
                          spacing: cell.width * 2,
                          runSpacing: cell.height,
                          children: [
                            for (final action in _actions)
                              TerminalTextAction(
                                key: ValueKey('api-form:${action.id}'),
                                label: action.label,
                                padding: EdgeInsets.zero,
                                focusNode: _buttons.putIfAbsent(
                                  action.id,
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
                ),
              ),
              Padding(
                padding: EdgeInsets.symmetric(
                  horizontal: cell.width * 2,
                  vertical: cell.height,
                ),
                child: Text(
                  [
                    for (final (command, label) in [
                      (
                        'picker.accept',
                        _editing == null || widget.removing ? 'select' : 'save',
                      ),
                      (
                        'picker.complete',
                        widget.onSwitchPane != null ? 'pane' : 'next',
                      ),
                      ('picker.cancel', 'back'),
                    ])
                      if (effectiveCommandHint(
                            context,
                            command,
                            contextKind: KeymapContext.picker,
                          )
                          case final hint?)
                        '${hint.replaceAll('⇥', 'Tab').replaceAll('↵', 'Enter')} $label',
                  ].join('  ·  '),
                  style: muted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _scope.dispose();
    for (final field in _fields.values) {
      field.clear();
      field.dispose();
    }
    for (final node in [..._inputs.values, ..._buttons.values]) {
      node.dispose();
    }
    super.dispose();
  }
}
