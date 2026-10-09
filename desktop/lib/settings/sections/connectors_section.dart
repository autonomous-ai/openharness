import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../connectors/connector_icons.dart';
import '../../connectors/connectors_controller.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_dialog.dart';
import '../../shared/widgets/app_icon_button.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/toolbar_pill.dart';
import '../../state/app_state.dart';

/// Settings ▸ Connectors: connect a service once on this computer, and every
/// local agent (Claude Code, Codex, OpenCode) gets it. The same list and
/// sign-ins as `harness connections` and the Grid app's Connectors page; only
/// the service's own consent page opens in the browser.
class ConnectorsSection extends StatefulWidget {
  const ConnectorsSection({super.key, required this.notifier, this.controller});

  final AppNotifier notifier;

  /// Injected by tests; otherwise this computer's.
  final ConnectorsController? controller;

  @override
  State<ConnectorsSection> createState() => _ConnectorsSectionState();
}

class _ConnectorsSectionState extends State<ConnectorsSection> {
  late final ConnectorsController _controller =
      widget.controller ?? ConnectorsController(widget.notifier);
  final _search = TextEditingController();
  bool _connectedOnly = false;

  @override
  void initState() {
    super.initState();
    _controller.refresh();
  }

  @override
  void dispose() {
    if (widget.controller == null) _controller.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SectionScaffold(
      title: 'Connectors',
      subtitle:
          'Connect your agents to tools outside this computer: a tracker, a design tool, a web service.',
      child: ListenableBuilder(
        listenable: Listenable.merge([_controller, _search]),
        builder: (context, _) => _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final theme = Theme.of(context);
    final query = _search.text.trim().toLowerCase();
    bool matches(ConnectorCard card) =>
        query.isEmpty ||
        '${card.name} ${card.description}'.toLowerCase().contains(query);
    final on = _controller.cards.where((c) => c.connected && matches(c)).toList();
    final off = _controller.cards.where((c) => !c.connected && matches(c)).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('connectors-search'),
                controller: _search,
                decoration: const InputDecoration(
                  hintText: 'Search connectors',
                  prefixIcon: Icon(AppIcons.search, size: AppIcons.inlineSize),
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: 8),
            AppIconButton(
              icon: AppIcons.refreshCw,
              tooltip: 'Refresh',
              spinning: _controller.loading,
              onPressed: _controller.refresh,
            ),
            const SizedBox(width: 8),
            FilledButton.icon(
              key: const ValueKey('connectors-add-custom'),
              onPressed: () => _addCustom(context),
              icon: const Icon(AppIcons.plus, size: AppIcons.inlineSize),
              label: const Text('Add custom'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            ToolbarPill(
              active: !_connectedOnly,
              onTap: () => setState(() => _connectedOnly = false),
              child: const Text('Browse'),
            ),
            const SizedBox(width: 8),
            ToolbarPill(
              active: _connectedOnly,
              onTap: () => setState(() => _connectedOnly = true),
              child: const Text('Connected'),
            ),
          ],
        ),
        if (!_controller.signedIn) ...[
          const SizedBox(height: 12),
          Text(
            'GitHub, Slack, Google and a few more sign in through your Harness account. Run harness login, then refresh to connect them.',
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
        if (_controller.error != null || _controller.notice.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            _controller.error ?? _controller.notice,
            key: const ValueKey('connectors-notice'),
            style: theme.textTheme.bodySmall?.copyWith(
              color: _controller.error != null ? theme.colorScheme.error : theme.colorScheme.primary,
            ),
          ),
        ],
        const SizedBox(height: 8),
        Expanded(
          child: _controller.cards.isEmpty && _controller.loading
              ? const Center(child: Text('Loading connectors…'))
              : ListView(
                  children: [
                    _group(context, 'Connected', on,
                        query.isEmpty ? 'Nothing connected yet. Choose a service below.' : 'No connected service matches.'),
                    if (!_connectedOnly) _group(context, 'Available', off, 'No service matches.'),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _group(BuildContext context, String title, List<ConnectorCard> cards, String empty) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${title.toUpperCase()}  ${cards.length}',
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              letterSpacing: 1,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 10),
          if (cards.isEmpty)
            Text(empty, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant))
          else
            LayoutBuilder(
              builder: (context, box) {
                final columns = (box.maxWidth / 300).floor().clamp(1, 4);
                final width = (box.maxWidth - (columns - 1) * 12) / columns;
                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (final card in cards)
                      SizedBox(width: width, child: _ConnectorTile(
                        card: card,
                        waiting: _controller.pending.contains(card.code),
                        onConnect: () => _controller.connect(card),
                        onDisconnect: () => _confirmDisconnect(context, card),
                      )),
                  ],
                );
              },
            ),
        ],
      ),
    );
  }

  Future<void> _confirmDisconnect(BuildContext context, ConnectorCard card) async {
    final yes = await showAppDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Disconnect ${card.name}?'),
        content: const Text(
          'Agents on this computer stop using this account. To revoke it everywhere, use the service\'s settings.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Disconnect')),
        ],
      ),
    );
    if (yes == true) await _controller.disconnect(card);
  }

  Future<void> _addCustom(BuildContext context) => showAppDialog<void>(
    context: context,
    builder: (context) => _AddCustomDialog(controller: _controller),
  );
}

/// One service: its icon and name, Signed in (or Reconnect), Connect or
/// Disconnect, and what it gives the agents.
class _ConnectorTile extends StatelessWidget {
  const _ConnectorTile({
    required this.card,
    required this.waiting,
    required this.onConnect,
    required this.onDisconnect,
  });

  final ConnectorCard card;
  final bool waiting;
  final VoidCallback onConnect;
  final VoidCallback onDisconnect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final connected = card.state == 'connected';
    Widget badge(String text, Color color) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(6)),
      child: Text(text, overflow: TextOverflow.ellipsis, style: theme.textTheme.labelSmall?.copyWith(color: color)),
    );
    final about = connected && !card.tools
        ? '${card.description} Agents use it with harness connections call.'
        : card.description;
    return Container(
      key: ValueKey('connector-${card.code}'),
      constraints: const BoxConstraints(minHeight: 112),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppPalette.cardBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ConnectorMark(code: card.code, name: card.name),
              const SizedBox(width: 10),
              // The name and its badge take the row; the action keeps to the right edge.
              Expanded(
                child: Row(
                  children: [
                    Flexible(
                      child: Text(card.name, overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                    ),
                    if (connected) ...[
                      const SizedBox(width: 8),
                      Flexible(child: badge(card.account.isEmpty ? 'Signed in' : card.account, theme.colorScheme.primary)),
                    ],
                    if (card.state == 'reconnect') ...[
                      const SizedBox(width: 8),
                      badge('Reconnect', Colors.amber),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (waiting)
                Text('Waiting for sign-in…', style: theme.textTheme.labelSmall?.copyWith(color: muted))
              else if (card.connected) ...[
                if (card.state == 'reconnect' && !card.custom)
                  TextButton(onPressed: onConnect, child: const Text('Reconnect')),
                AppIconButton(icon: AppIcons.unplug, tooltip: 'Disconnect ${card.name}', onPressed: onDisconnect),
              ] else if (card.reason.isNotEmpty) ...[
                Flexible(child: Text(card.reason, textAlign: TextAlign.right,
                    style: theme.textTheme.labelSmall?.copyWith(color: muted))),
                const SizedBox(width: 6),
                AppIconButton(icon: AppIcons.plus, tooltip: card.reason, onPressed: null),
              ] else
                AppIconButton(icon: AppIcons.plus, tooltip: 'Connect ${card.name}', onPressed: onConnect),
            ],
          ),
          const SizedBox(height: 10),
          Text(about, maxLines: 2, overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(color: muted)),
        ],
      ),
    );
  }
}

/// A service's icon, bundled with the app (assets/connector-icons), or its
/// initial when it has none (a custom server).
class ConnectorMark extends StatelessWidget {
  const ConnectorMark({super.key, required this.code, required this.name, this.size = 26});

  final String code;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final path = connectorIcons[code];
    final Widget mark;
    if (path == null) {
      mark = Center(
        child: Text(name.isEmpty ? '?' : name.characters.first.toUpperCase(),
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: size * 0.5, color: Colors.white)),
      );
    } else if (path.endsWith('.svg')) {
      mark = SvgPicture.asset(path, fit: BoxFit.contain);
    } else {
      mark = Image.asset(path, fit: BoxFit.contain);
    }
    return Container(
      width: size,
      height: size,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: path == null ? AppPalette.accentMuted : AppPalette.cardBgHover,
        borderRadius: BorderRadius.circular(6),
      ),
      child: mark,
    );
  }
}

class _AddCustomDialog extends StatefulWidget {
  const _AddCustomDialog({required this.controller});
  final ConnectorsController controller;

  @override
  State<_AddCustomDialog> createState() => _AddCustomDialogState();
}

class _AddCustomDialogState extends State<_AddCustomDialog> {
  final _name = TextEditingController();
  final _url = TextEditingController();
  final _headers = TextEditingController();
  String? _error;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    _headers.dispose();
    super.dispose();
  }

  Map<String, String>? _parsedHeaders() {
    final result = <String, String>{};
    for (final line in _headers.text.split('\n').map((l) => l.trim()).where((l) => l.isNotEmpty)) {
      final at = line.indexOf(':');
      if (at < 1) return null;
      result[line.substring(0, at).trim()] = line.substring(at + 1).trim();
    }
    return result;
  }

  Future<void> _save() async {
    final headers = _parsedHeaders();
    if (headers == null) {
      setState(() => _error = 'Write each header as Name: value.');
      return;
    }
    setState(() { _saving = true; _error = null; });
    final error = await widget.controller.addCustom(_name.text.trim(), _url.text.trim(), headers);
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
    } else {
      setState(() { _saving = false; _error = error; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: const Text('Add custom'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('A remote MCP server. If it asks you to sign in, Harness opens its sign-in page.',
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
            const SizedBox(height: 16),
            TextField(key: const ValueKey('custom-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name')),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('custom-url'),
              controller: _url,
              decoration: const InputDecoration(labelText: 'Remote MCP server URL', hintText: 'https://example.com/mcp'),
            ),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text('Advanced', style: theme.textTheme.bodySmall),
              children: [
                TextField(
                  controller: _headers,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(
                    labelText: 'Headers (Name: value, one per line)',
                    hintText: 'Authorization: Bearer …',
                  ),
                ),
              ],
            ),
            if (_error != null) Text(_error!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error)),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Continue')),
      ],
    );
  }
}
