import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../ws/ws_conn.dart';

typedef CommentAction = Future<Map<String, dynamic>> Function(
  String action,
  Map<String, dynamic> payload,
);

/// One discussion UI for the owner and observers. Authorization is always repeated by the owner.
class HarnessComments extends StatefulWidget {
  const HarnessComments({
    super.key,
    required this.manage,
    this.updates,
    this.onSignIn,
    this.headerAction,
    this.padding = const EdgeInsets.all(16),
  });
  final CommentAction manage;
  final Listenable? updates;
  final VoidCallback? onSignIn;
  final Widget? headerAction;
  final EdgeInsetsGeometry padding;
  @override
  State<HarnessComments> createState() => _HarnessCommentsState();
}

class _HarnessCommentsState extends State<HarnessComments> {
  final _text = TextEditingController();
  List<Map<String, dynamic>> _comments = [];
  bool _loading = true, _refreshing = false, _busy = false, _canComment = false;
  int _revision = 0;
  String? _error, _postId, _postText;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    widget.updates?.addListener(_refresh);
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
  }

  @override
  void didUpdateWidget(HarnessComments oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.updates != widget.updates) {
      oldWidget.updates?.removeListener(_refresh);
      widget.updates?.addListener(_refresh);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.updates?.removeListener(_refresh);
    _text.dispose();
    super.dispose();
  }

  String _message(Object error) =>
      error is WsRequestFailure && error.detail != null
      ? error.detail!
      : 'Could not reach the owner. Your draft is saved here; try again.';
  void _accept(Map<String, dynamic> data) {
    if (data['error'] != null) {
      throw WsRequestFailure(
        responseType: 'comments',
        code: '${data['error']}',
        detail: data['detail'] as String?,
      );
    }
    _comments = [
      for (final c in data['comments'] as List? ?? [])
        Map<String, dynamic>.from(c as Map),
    ];
    _canComment = data['canComment'] == true;
    _loading = false;
  }

  void _refresh() {
    unawaited(_load());
  }

  Future<void> _load() async {
    if (_refreshing || _busy) return;
    _refreshing = true;
    final revision = _revision;
    try {
      final data = await widget.manage('comments', {});
      if (mounted && revision == _revision) {
        setState(() {
          _accept(data);
          _error = null;
        });
      }
    } catch (error) {
      if (mounted && revision == _revision) {
        setState(() {
          _loading = false;
          _error = _message(error);
        });
      }
    } finally {
      _refreshing = false;
    }
  }

  static String _uuid() {
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }

  Future<void> _act(String action, Map<String, dynamic> payload) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _revision++;
      _error = null;
    });
    try {
      final data = await widget.manage(action, payload);
      if (mounted) {
        setState(() {
          _accept(data);
          if (action == 'comment_post') {
            _text.clear();
            _postId = null;
            _postText = null;
          }
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = _message(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _post() {
    final text = _text.text.trim();
    if (text.isEmpty || !_canComment || _busy) return;
    if (_postText != text) {
      _postText = text;
      _postId = _uuid();
    }
    unawaited(_act('comment_post', {'id': _postId, 'text': text}));
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DesktopChrome(
      child: Padding(
        padding: widget.padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      text: 'Comments',
                      children: [
                        if (_comments.isNotEmpty)
                          TextSpan(
                            text: ' (${_comments.length})',
                            style: DesktopChrome.metadata(),
                          ),
                      ],
                    ),
                    key: const ValueKey('comments-heading'),
                    style: DesktopChrome.heading(),
                  ),
                ),
                if (widget.headerAction case final action?) ...[
                  const SizedBox(width: DesktopChrome.controlGap),
                  action,
                ],
              ],
            ),
            const SizedBox(height: DesktopChrome.groupGap),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) => Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(child: _discussion()),
                    if (_error != null ||
                        _canComment ||
                        widget.onSignIn != null)
                      ConstrainedBox(
                        // Keep history visible while allowing a long failure or
                        // an enlarged composer to scroll inside a short pane.
                        constraints: BoxConstraints(
                          maxHeight: constraints.maxHeight * .65,
                        ),
                        child: SingleChildScrollView(
                          primary: false,
                          child: _composer(
                            maxLines:
                                constraints.maxHeight <
                                    MediaQuery.textScalerOf(context).scale(240)
                                ? 2
                                : 3,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _discussion() {
    if (_loading || _comments.isEmpty) {
      return SingleChildScrollView(
        primary: false,
        child: Text(
          _loading
              ? 'Loading comments…'
              : _error != null
              ? 'Comments are unavailable.'
              : 'Start the conversation.',
          style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
        ),
      );
    }
    return ListView.separated(
      key: const ValueKey('comments-list'),
      primary: false,
      itemCount: _comments.length,
      separatorBuilder: (_, _) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Divider(height: 1, color: DesktopChrome.rim),
      ),
      itemBuilder: (context, index) {
        final comment = _comments[index];
        final author = '${comment['authorName']}';
        final date = DateTime.tryParse('${comment['createdAt']}')?.toLocal();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Tooltip(
                        message: author,
                        child: Text(
                          author,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.control(medium: true),
                        ),
                      ),
                      if (date != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          '${date.month}/${date.day} ${date.hour}:${date.minute.toString().padLeft(2, '0')}',
                          style: DesktopChrome.metadata(),
                        ),
                      ],
                    ],
                  ),
                ),
                if (comment['canDelete'] == true) ...[
                  const SizedBox(width: DesktopChrome.controlGap),
                  DesktopPill(
                    label: 'Remove',
                    tooltip: 'Remove comment by $author',
                    quiet: true,
                    compact: true,
                    onPressed: _busy
                        ? null
                        : () => _act('comment_remove', {'id': comment['id']}),
                  ),
                ],
              ],
            ),
            const SizedBox(height: DesktopChrome.controlGap),
            SelectionArea(
              child: Text(
                '${comment['text']}',
                style: DesktopChrome.text(size: 13),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _composer({required int maxLines}) {
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      borderSide: BorderSide(color: DesktopChrome.rim),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Divider(height: 1, color: DesktopChrome.rim),
        ),
        if (_error != null) ...[
          Semantics(
            liveRegion: true,
            child: SelectableText(
              _error!,
              style: DesktopChrome.text(
                size: 13,
                color: Theme.of(context).colorScheme.error,
              ),
            ),
          ),
          const SizedBox(height: DesktopChrome.controlGap),
        ],
        if (_canComment) ...[
          TextField(
            key: const Key('comment-input'),
            controller: _text,
            readOnly: _busy,
            style: DesktopChrome.text(size: 13),
            cursorColor: DesktopChrome.accent,
            minLines: 1,
            maxLines: maxLines,
            maxLength: 4000,
            decoration: InputDecoration(
              hintText: 'Leave a comment…',
              hintStyle: DesktopChrome.text(
                size: 13,
                color: DesktopChrome.muted,
              ),
              border: border,
              enabledBorder: border,
              focusedBorder: border.copyWith(
                borderSide: BorderSide(
                  color: DesktopChrome.focusRing,
                  width: 1.5,
                ),
              ),
              filled: true,
              fillColor: DesktopChrome.field,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 10,
              ),
              counterText: '',
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: DesktopChrome.controlGap),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton(
              key: const ValueKey('comment-post'),
              onPressed: _busy || _text.text.trim().isEmpty ? null : _post,
              child: Text(_busy ? 'Saving…' : 'Comment'),
            ),
          ),
        ] else if (widget.onSignIn != null)
          Align(
            alignment: Alignment.centerLeft,
            child: DesktopPill(
              label: 'Sign in to comment',
              onPressed: widget.onSignIn,
            ),
          ),
      ],
    );
  }
}
