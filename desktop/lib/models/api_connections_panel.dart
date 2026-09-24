import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_theme.dart';
import 'api_connections_controller.dart';
import 'model_mark.dart';

/// The same row rhythm as Models. The editor stays inside the panel instead of
/// opening another settings window or sending credentials to a chat.
class ApiConnectionsPanel extends StatefulWidget {
  const ApiConnectionsPanel({
    super.key,
    required this.controller,
    required this.query,
    required this.onEditingChanged,
    this.showPresets = true,
  });
  final ApiConnectionsController controller;
  final String query;
  final ValueChanged<bool> onEditingChanged;
  final bool showPresets;
  @override
  State<ApiConnectionsPanel> createState() => _ApiConnectionsPanelState();
}

class _ApiConnectionsPanelState extends State<ApiConnectionsPanel> {
  ApiConnection? _editing;
  String? _removing;

  void _edit(ApiConnection? connection) {
    if (connection != null && connection.provider != 'custom') {
      final selected = connection;
      final preset = widget.controller.presets
          .where((row) => row.provider == selected.provider)
          .firstOrNull;
      var name = selected.name;
      if (selected.id.isEmpty) {
        var suffix = 2;
        while (widget.controller.connections.any(
          (row) => row.name.toLowerCase() == name.toLowerCase(),
        )) {
          name = '${selected.name} ${suffix++}';
        }
      }
      connection = ApiConnection({
        ...?preset?.data,
        ...selected.data,
        'name': name,
      });
    }
    setState(() {
      _editing = connection;
      _removing = null;
    });
    widget.onEditingChanged(connection != null);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final editing = _editing;
      if (editing != null) {
        return _ApiEditor(
          key: ValueKey('${editing.id}:${editing.provider}'),
          connection: editing,
          controller: controller,
          backLabel: widget.showPresets ? 'Back to APIs' : 'Back to all models',
          onClose: () => _edit(null),
        );
      }
      final query = widget.query.toLowerCase();
      final connections = controller.connections
          .where((row) => row.matches(query))
          .toList();
      final presets = controller.presets
          // Subscription providers remain usable through Custom API and any
          // saved connections, without suggesting a second setup here.
          .where(
            (row) =>
                row.provider != 'openai' &&
                row.provider != 'anthropic' &&
                row.matches(query),
          )
          .toList();
      final customMatches = 'custom api'.contains(query);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (controller.error case final error?)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      error,
                      style: AppType.monoMeta(color: AppPalette.textSecondary),
                    ),
                  ),
                  TextButton(
                    onPressed: controller.loading ? null : controller.refresh,
                    child: const Text('Refresh'),
                  ),
                ],
              ),
            ),
          if (!controller.loaded && controller.loading) _note('Loading APIs…'),
          if (connections.isNotEmpty) ...[
            _note(widget.showPresets ? 'Saved' : 'APIs'),
            for (final connection in connections) _row(connection, saved: true),
          ],
          if (controller.loaded && widget.showPresets) ...[
            _note('Add API'),
            for (final preset in presets) _row(preset),
            if (customMatches)
              _row(
                const ApiConnection({
                  'provider': 'custom',
                  'name': 'Custom API',
                }),
              ),
            if (connections.isEmpty && presets.isEmpty && !customMatches)
              _note('No matching APIs'),
          ],
        ],
      );
    },
  );

  Widget _note(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 14, 12, 6),
    child: Text(text, style: AppType.monoMeta(color: AppPalette.textSecondary)),
  );

  Widget _row(ApiConnection connection, {bool saved = false}) {
    final controller = widget.controller;
    final removing = _removing == connection.id && saved;
    final enabled = controller.available && !controller.saving;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 14, 6, 14),
      child: Row(
        children: [
          if (connection.provider == 'openai' ||
              connection.provider == 'anthropic')
            ModelMark(model: connection.provider)
          else
            const Icon(LucideIcons.plug, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  connection.name,
                  style: AppType.label(
                    color: AppPalette.textPrimary,
                    height: 1.3,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                Text(
                  removing
                      ? 'Remove this saved key?'
                      : connection.provider == 'custom' && !saved
                      ? 'Your endpoint and key'
                      : connection.host,
                  style: AppType.monoMeta(
                    color: AppPalette.textSecondary,
                    height: 1.3,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          if (removing) ...[
            TextButton(
              onPressed: enabled
                  ? () async {
                      if (await controller.remove(connection.id) && mounted) {
                        setState(() => _removing = null);
                      }
                    }
                  : null,
              child: const Text('Remove'),
            ),
            IconButton(
              tooltip: 'Keep ${connection.name}',
              onPressed: () => setState(() => _removing = null),
              icon: const Icon(LucideIcons.x, size: 16),
            ),
          ] else ...[
            IconButton(
              tooltip: '${saved ? 'Edit' : 'Add'} ${connection.name}',
              onPressed: enabled ? () => _edit(connection) : null,
              icon: Icon(
                saved ? LucideIcons.pencil : LucideIcons.plus,
                size: 18,
              ),
            ),
            if (saved)
              IconButton(
                tooltip: 'Remove ${connection.name}',
                onPressed: enabled
                    ? () => setState(() => _removing = connection.id)
                    : null,
                icon: const Icon(LucideIcons.trash2, size: 16),
              ),
          ],
        ],
      ),
    );
  }
}

class _ApiEditor extends StatefulWidget {
  const _ApiEditor({
    super.key,
    required this.connection,
    required this.controller,
    required this.onClose,
    required this.backLabel,
  });
  final ApiConnection connection;
  final ApiConnectionsController controller;
  final VoidCallback onClose;
  final String backLabel;
  @override
  State<_ApiEditor> createState() => _ApiEditorState();
}

class _ApiEditorState extends State<_ApiEditor> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(
    text: custom && !existing ? '' : widget.connection.name,
  );
  late final _url = TextEditingController(text: widget.connection.baseUrl);
  late final _environment = TextEditingController(
    text: widget.connection.keyEnv,
  );
  late final _header = TextEditingController(
    text: widget.connection.authHeader,
  );
  late final _prefix = TextEditingController(
    text: widget.connection.authPrefix,
  );
  final _key = TextEditingController();
  bool _advanced = false, _visible = false;
  String? _linkError, _clipboardError;
  bool get custom => widget.connection.provider == 'custom';
  bool get existing => widget.connection.id.isNotEmpty;

  @override
  void dispose() {
    for (final field in [_name, _url, _environment, _header, _prefix, _key]) {
      field.clear();
      field.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (widget.controller.saving || !_form.currentState!.validate()) return;
    final saved = await widget.controller.save({
      if (existing) 'id': widget.connection.id,
      'provider': widget.connection.provider,
      'name': _name.text,
      'baseUrl': _url.text,
      'keyEnv': _environment.text,
      'authHeader': _header.text,
      'authPrefix': _prefix.text,
      'apiKey': _key.text,
    });
    if (saved && mounted) widget.onClose();
  }

  Future<void> _openKeyPage(String url) async {
    try {
      final opened = await launchUrl(
        Uri.parse(url),
        mode: LaunchMode.externalApplication,
      );
      if (mounted) {
        setState(
          () => _linkError = opened
              ? null
              : 'Could not open the browser. Try again.',
        );
      }
    } catch (_) {
      if (mounted) {
        setState(() => _linkError = 'Could not open the browser. Try again.');
      }
    }
  }

  Future<void> _pasteKey() async {
    final previous = _key.value;
    try {
      final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text
          ?.trim();
      if (!mounted || widget.controller.saving || _key.value != previous) {
        return;
      }
      setState(() {
        _clipboardError = text == null || text.isEmpty
            ? 'Copy an API key first.'
            : null;
        if (_clipboardError == null) {
          _key.value = TextEditingValue(
            text: text!,
            selection: TextSelection.collapsed(offset: text.length),
          );
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() => _clipboardError = 'Could not paste. Try again.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final enabled = controller.available && !controller.saving;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
      },
      child: FocusScope(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
          child: Form(
            key: _form,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    IconButton(
                      onPressed: widget.onClose,
                      tooltip: widget.backLabel,
                      icon: const Icon(LucideIcons.arrowLeft, size: 18),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        custom ? 'Custom API' : widget.connection.name,
                        style: AppType.label(color: AppPalette.textPrimary),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (custom || _advanced) ...[
                  _field(
                    _name,
                    'Name',
                    autofocus: custom,
                    validator: _required,
                  ),
                  _field(
                    _url,
                    'Base URL',
                    hint: 'https://api.example.com/v1',
                    validator: (value) {
                      final url = Uri.tryParse(value?.trim() ?? '');
                      return url == null ||
                              !['https', 'http'].contains(url.scheme) ||
                              url.host.isEmpty ||
                              url.userInfo.isNotEmpty ||
                              url.hasQuery ||
                              url.hasFragment
                          ? 'Enter an API URL without credentials or query parameters.'
                          : null;
                    },
                  ),
                ],
                _field(
                  _key,
                  'API key',
                  autofocus: !custom,
                  hint: existing ? 'Leave blank to keep saved key' : null,
                  secret: true,
                  validator: (value) => existing ? null : _required(value),
                ),
                if (widget.connection.keyUrl case final keyUrl?)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: () => _openKeyPage(keyUrl),
                      icon: const Icon(LucideIcons.arrowUpRight, size: 14),
                      label: const Text('Get API key'),
                    ),
                  ),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () => setState(() => _advanced = !_advanced),
                    icon: Icon(
                      _advanced
                          ? LucideIcons.chevronUp
                          : LucideIcons.chevronDown,
                      size: 14,
                    ),
                    label: const Text('Advanced'),
                  ),
                ),
                if (_advanced) ...[
                  _field(
                    _environment,
                    'Key environment variable',
                    hint: 'MY_API_KEY',
                  ),
                  _field(
                    _header,
                    'Authentication header',
                    hint: 'Authorization',
                    validator: _required,
                  ),
                  _field(
                    _prefix,
                    'Key prefix',
                    hint: 'Bearer, Key, or leave blank',
                  ),
                ],
                if ((controller.error ?? _clipboardError ?? _linkError)
                    case final error?)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text(
                      error,
                      style: AppType.monoMeta(color: AppPalette.textSecondary),
                    ),
                  ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Stored on this computer.',
                        style: AppType.monoMeta(
                          color: AppPalette.textSecondary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: enabled ? _save : null,
                      child: Text(controller.saving ? 'Saving…' : 'Save'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String? _required(String? value) =>
      value == null || value.trim().isEmpty ? 'Required' : null;
  Widget _field(
    TextEditingController field,
    String label, {
    String? hint,
    bool secret = false,
    bool autofocus = false,
    String? Function(String?)? validator,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextFormField(
      key: ValueKey('api-field-$label'),
      controller: field,
      autofocus: autofocus,
      enabled: !widget.controller.saving,
      obscureText: secret && !_visible,
      enableSuggestions: false,
      autocorrect: false,
      style: AppType.monoLabel(),
      validator: validator,
      onChanged: secret
          ? (_) {
              if (_clipboardError != null) {
                setState(() => _clipboardError = null);
              }
            }
          : null,
      onFieldSubmitted: (_) => _save(),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        labelStyle: AppType.monoMeta(color: AppPalette.textSecondary),
        hintStyle: AppType.monoMeta(color: AppPalette.textFaint),
        filled: true,
        fillColor: AppPalette.windowBg,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
        suffixIcon: secret
            ? Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: 'Paste API key',
                    onPressed: widget.controller.saving ? null : _pasteKey,
                    icon: const Icon(LucideIcons.clipboardPaste, size: 16),
                  ),
                  IconButton(
                    tooltip: _visible ? 'Hide API key' : 'Show API key',
                    onPressed: () => setState(() => _visible = !_visible),
                    icon: Icon(
                      _visible ? LucideIcons.eyeOff : LucideIcons.eye,
                      size: 16,
                    ),
                  ),
                ],
              )
            : null,
      ),
    ),
  );
}
