// Inbox (the mockup's renderInbox): a header column (Close, "Inbox", "N unread"), then the notices as cards, newest
// first, in a row that scrolls sideways and comes to rest on a card's edge. Nothing in it: "No notification".
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../attention/glyphs.dart';
import '../lists/notice_card.dart';
import '../lists/round_button.dart';
import '../lists/snap_physics.dart';
import '../tokens.dart';

class InboxPage extends StatefulWidget {
  const InboxPage({super.key, required this.model});
  final BarModel model;

  @override
  State<InboxPage> createState() => _InboxPageState();
}

/// The row's leading padding and a card's step (its width and the gap), the mockup's `.notes`.
const double _lead = 6, _gap = 16;

class _InboxPageState extends State<InboxPage> with SingleTickerProviderStateMixin {
  final ScrollController _scroll = SnapController(_lead);

  /// The unread dots' pulse (`pulse 1.4s ease-in-out infinite`: down to .35 and back), running only while a card is
  /// unread.
  late final AnimationController _beat =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));
  late final Animation<double> _pulse = TweenSequence<double>([
    TweenSequenceItem(tween: Tween(begin: 1.0, end: 0.35).chain(CurveTween(curve: Curves.easeInOut)), weight: 50),
    TweenSequenceItem(tween: Tween(begin: 0.35, end: 1.0).chain(CurveTween(curve: Curves.easeInOut)), weight: 50),
  ]).animate(_beat);

  BarModel get model => widget.model;

  @override
  void initState() {
    super.initState();
    model.addListener(_beatIfUnread);
    _beatIfUnread();
  }

  @override
  void didUpdateWidget(InboxPage old) {
    super.didUpdateWidget(old);
    if (old.model != model) {
      old.model.removeListener(_beatIfUnread);
      model.addListener(_beatIfUnread);
      _beatIfUnread();
    }
  }

  @override
  void dispose() {
    model.removeListener(_beatIfUnread);
    _beat.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _beatIfUnread() {
    if (model.unread > 0) {
      if (!_beat.isAnimating) _beat.repeat();
    } else {
      _beat
        ..stop()
        ..value = 0;
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: model,
        builder: (context, _) => Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _head(),
          Expanded(child: model.inbox.isEmpty ? _none() : _notes()),
        ]),
      );

  /// Close, "Inbox" and the unread count. The whole column closes: the bar's touch lands off the finger.
  Widget _head() {
    final unread = model.unread;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: model.closeList,
      child: SizedBox(
        width: 220,
        child: Padding(
          padding: const EdgeInsets.only(left: 34),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const RoundButton(Glyph.cross),
            const SizedBox(height: 18),
            Text('Inbox', style: Face.s(26, weight: FontWeight.w600)),
            const SizedBox(height: 18),
            SizedBox(
              height: 24,
              child: unread > 0 ? Text('$unread unread', style: Face.s(19, color: Ink.ask)) : null,
            ),
          ]),
        ),
      ),
    );
  }

  Widget _none() => Padding(
        padding: const EdgeInsets.fromLTRB(_lead, 24, 30, 24),
        child: Center(child: Text('No notification', style: Face.s(25, color: Ink.dim))),
      );

  Widget _notes() {
    final now = model.now();
    final notices = model.inbox;
    return ListView.separated(
      controller: _scroll,
      scrollDirection: Axis.horizontal,
      physics: const SnapPhysics(origin: _lead, extent: kNoticeWidth + _gap, parent: ClampingScrollPhysics()),
      padding: const EdgeInsets.fromLTRB(_lead, 24, 30, 24),
      itemCount: notices.length,
      separatorBuilder: (context, i) => const SizedBox(width: _gap),
      itemBuilder: (context, i) {
        final n = notices[i];
        return NoticeCard(
          key: ObjectKey(n),
          notice: n,
          now: now,
          pulse: _pulse,
          onTap: () => model.tapNotice(n),
        );
      },
    );
  }
}
