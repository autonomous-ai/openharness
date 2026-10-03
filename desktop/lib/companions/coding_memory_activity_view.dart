part of 'coding_memory_view.dart';

class _CodingMemoryActivityView extends StatefulWidget {
  const _CodingMemoryActivityView({
    required this.library,
    required this.onOpen,
  });
  final CodingMemoryLibrary library;
  final Future<void> Function(String) onOpen;
  @override
  State<_CodingMemoryActivityView> createState() =>
      _CodingMemoryActivityViewState();
}

class _CodingMemoryActivityViewState extends State<_CodingMemoryActivityView> {
  late CodingMemoryActivity activity;
  final _ratingFocus = <String, FocusNode>{};
  String _identity(Map<String, dynamic> item) =>
      '${memoryMap(item['record'])['id']}:${memoryMap(item['record'])['revision']}:${memoryMap(item['recall'])['receiptId']}';
  FocusNode _node(Map<String, dynamic> item, String choice) =>
      _ratingFocus.putIfAbsent('${_identity(item)}:$choice', () => FocusNode());

  void _changed() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final prefixes = activity.items
          .map((item) => '${_identity(item)}:')
          .toSet();
      for (final key in _ratingFocus.keys.toList()) {
        if (!prefixes.any(key.startsWith)) _ratingFocus.remove(key)!.dispose();
      }
    });
  }

  Future<void> _rate(Map<String, dynamic> item, String? value) async {
    await activity.rate(item, value);
    if (!mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          activity.items.any(
            (current) => _identity(current) == _identity(item),
          )) {
        _node(item, value ?? 'helpful').requestFocus();
      }
    });
  }

  @override
  void initState() {
    super.initState();
    activity = CodingMemoryActivity(widget.library)
      ..addListener(_changed)
      ..refresh();
  }

  @override
  void didUpdateWidget(_CodingMemoryActivityView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.library != widget.library) {
      activity.dispose();
      activity = CodingMemoryActivity(widget.library)
        ..addListener(_changed)
        ..refresh();
    }
  }

  @override
  void dispose() {
    activity.dispose();
    for (final node in _ratingFocus.values) {
      node.dispose();
    }
    super.dispose();
  }

  String _where(Map<String, dynamic> session) =>
      '${switch (session['engine']) {
        'claude' => 'Claude',
        'opencode' => 'OpenCode',
        _ => 'Codex',
      }} · ${memoryMap(session['project'])['name'] ?? 'Companion conversation'}';

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: activity,
    builder: (context, _) {
      final selection = activity.selection;
      final busy = activity.busy || widget.library.busy;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _text(
            'See the last recorded recall for an open coding session. You can check each memory and tell your companion whether it helped.',
          ),
          const SizedBox(height: 16),
          if (activity.available == false)
            _text(
              'Recall activity is not available in this local service yet. You can still read individual memories and their evidence.',
            ),
          if (activity.sessions.isNotEmpty) ...[
            Semantics(
              enabled: !activity.writing,
              child: ExcludeSemantics(
                excluding: activity.writing,
                child: ExcludeFocus(
                  excluding: activity.writing,
                  child: IgnorePointer(
                    ignoring: activity.writing,
                    child: AppSelectField<String>(
                      key: const ValueKey('memory-activity-session'),
                      semanticLabel: 'Coding session',
                      value: activity.selectedAgentId ?? '',
                      filterable: true,
                      options: [
                        for (final session in activity.sessions)
                          SelectOption(
                            value: session['agentId'] as String,
                            label:
                                session['name'] as String? ?? 'Coding session',
                            note: _where(session),
                            detail:
                                memoryMap(session['project'])['location']
                                    as String?,
                          ),
                      ],
                      onChanged: (id) => unawaited(activity.select(id)),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],
          if (activity.error != null) ...[
            Semantics(liveRegion: true, child: _text(activity.error!)),
            TextButton(
              onPressed: busy ? null : () => activity.select(null),
              child: const Text('Show open sessions'),
            ),
          ],
          if (activity.busy && activity.sessions.isEmpty)
            _memorySurface(
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SkeletonText(style: AppType.body(), widthFactor: .7),
                  const SizedBox(height: 8),
                  SkeletonText(style: AppType.caption(), widthFactor: .5),
                ],
              ),
            ),
          if (!busy &&
              activity.error == null &&
              activity.available == true &&
              activity.sessions.isEmpty)
            _text(
              'No recall activity for open coding sessions yet. New activity appears when a supported agent requests memory.',
            ),
          if (selection != null) ...[
            _text(_where(selection)),
            _text(_time(context, selection['preparedAt']), small: true),
            if (memoryMap(selection['project'])['location']
                case final String location)
              _text(location, small: true),
            const SizedBox(height: 8),
            _text(
              selection['status'] == 'off'
                  ? 'Recall was paused for this request.'
                  : selection['selectedCount'] == 0
                  ? 'No memories were selected for the last recorded request.'
                  : selection['emittedAt'] == null
                  ? 'Selected for recall · Delivery not confirmed'
                  : 'Sent by Harness · Delivery not confirmed',
              small: true,
            ),
            if (!busy &&
                (selection['selectedCount'] as num? ?? 0) >
                    activity.items.length)
              _text(
                'Some earlier selections have changed or are no longer available. Only current memory versions are shown.',
                small: true,
              ),
            const SizedBox(height: 16),
            for (final item in activity.items) _item(item, busy),
            _text(
              'This records context prepared by Harness. It does not establish that the model received or used it. The time above may precede the current turn.',
              small: true,
            ),
          ],
          const SizedBox(height: 8),
          TextButton(
            onPressed: busy ? null : () => widget.library.refresh(),
            child: const Text('Refresh recall activity'),
          ),
        ],
      );
    },
  );

  Widget _item(Map<String, dynamic> item, bool busy) {
    final record = memoryMap(item['record']),
        recall = memoryMap(item['recall']);
    final feedback = memoryMap(recall['feedback'])['value'];
    final conditions = memoryMap(record['applicability']);
    return KeyedSubtree(
      key: ValueKey(
        '${record['id']}:${record['revision']}:${recall['receiptId']}',
      ),
      child: _memorySurface(
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _text(_scopeLabel(record), small: true),
            const SizedBox(height: 8),
            Text(
              record['claim'] as String,
              style: AppType.body(color: AppPalette.textPrimary, height: 1.5),
            ),
            if (record['rationale'] case final String reason) ...[
              const SizedBox(height: 8),
              _text(reason),
            ],
            const SizedBox(height: 8),
            _text(
              conditions.isEmpty
                  ? 'Applies across matching coding work.'
                  : 'Applies when ${conditions.entries.map((e) => '${_label(e.key)}: ${_label('${e.value}')}').join(', ')}.',
              small: true,
            ),
            if ((record['exceptions'] as List? ?? []).isNotEmpty)
              _fields(record['exceptions'], label: 'Exceptions'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                TextButton(
                  onPressed: busy
                      ? null
                      : () => widget.onOpen(record['id'] as String),
                  child: const Text('Read memory'),
                ),
                for (final choice in ['helpful', 'unhelpful'])
                  DesktopPill(
                    label: choice == 'helpful' ? 'Helpful' : 'Not helpful',
                    semanticLabel:
                        '${choice == 'helpful' ? 'Helpful' : 'Not helpful'}: ${record['claim']}',
                    selected: feedback == choice,
                    focusNode: _node(item, choice),
                    leading: SizedBox(
                      width: 16,
                      child: feedback == choice
                          ? const Icon(AppIcons.check, size: 16)
                          : null,
                    ),
                    onPressed: busy || recall['canFeedback'] != true
                        ? null
                        : () {
                            if (feedback != choice) {
                              unawaited(_rate(item, choice));
                            }
                          },
                  ),
                if (feedback != null)
                  TextButton(
                    focusNode: _node(item, 'clear'),
                    onPressed: busy ? null : () => _rate(item, null),
                    child: const Text('Clear feedback'),
                  ),
              ],
            ),
            if (recall['canGuideRecall'] == true)
              _text(
                'Your feedback helps choose memories for matching work. Correct the memory separately if the fact is wrong.',
                small: true,
              ),
          ],
        ),
      ),
    );
  }

  String _time(BuildContext context, Object? millis) {
    if (millis is! num) return 'Recall time unavailable';
    final date = DateTime.fromMillisecondsSinceEpoch(millis.toInt()).toLocal();
    final local = MaterialLocalizations.of(context);
    return 'Last recorded recall: ${local.formatMediumDate(date)} at ${local.formatTimeOfDay(TimeOfDay.fromDateTime(date), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}';
  }
}
