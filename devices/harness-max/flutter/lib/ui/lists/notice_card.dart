// One Inbox card (the mockup's `.ncard`): the pet, the name in the kind's colour, the app, the word and how long ago,
// then the words. An unread card is lit: a brighter fill, a 2 px ring and a glow under it in the kind's colour, and a
// pulsing dot; reading it dims it over 0.3 s.
import 'package:flutter/widgets.dart';

import '../../model/types.dart';
import '../app_icon.dart';
import '../attention/kind.dart';
import '../pet.dart';
import '../tokens.dart';
import 'css_shadow.dart';
import 'press.dart';

const double kNoticeWidth = 372;

/// How long ago, as the dial files it: "just now", "2 min ago", "3 h ago", "2 d ago".
String agoText(DateTime now, DateTime at) {
  final secs = now.difference(at).inSeconds;
  if (secs < 60) return 'just now';
  if (secs < 3600) return '${secs ~/ 60} min ago';
  if (secs < 86400) return '${secs ~/ 3600} h ago';
  return '${secs ~/ 86400} d ago';
}

class NoticeCard extends StatelessWidget {
  const NoticeCard({super.key, required this.notice, required this.now, required this.pulse, required this.onTap});
  final Notice notice;
  final DateTime now;

  /// The unread dot's opacity, shared by every card so the dots pulse together as the mockup's.
  final Animation<double> pulse;
  final VoidCallback onTap;

  static const _fill = Color(0xFF0B0B10), _fillLit = Color(0xFF121219), _rim = Color(0xFF22222A);
  static const _radius = BorderRadius.all(Radius.circular(22));

  @override
  Widget build(BuildContext context) {
    final n = notice;
    final ink = kindInk(n.kind);
    final lit = n.unread;
    final engine = petEngineOf(n.engine);
    return Press(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        curve: Curves.ease,
        width: kNoticeWidth,
        decoration: BoxDecoration(
          color: lit ? _fillLit : _fill,
          borderRadius: _radius,
          boxShadow: [cssShadow(lit ? ink : ink.withValues(alpha: 0), y: 16, blur: 40, spread: -18)],
        ),
        // The ring is the mockup's inset box-shadow: over the fill, taking no room, so reading a card moves nothing.
        foregroundDecoration: BoxDecoration(
          borderRadius: _radius,
          border: Border.all(color: lit ? ink : _rim, width: lit ? 2 : 1),
        ),
        child: Stack(children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                SizedBox(
                  width: 64,
                  height: 60,
                  child: PetView(
                      engine: engine, scene: smallPetScene(n.engine, n.kind), size: const Size(64, 60)),
                ),
                const SizedBox(width: 14),
                Flexible(child: _head(n, ink, lit)),
              ]),
              const SizedBox(height: 14),
              Text(n.text,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: Face.s(22, color: lit ? Ink.recap : Ink.rest, height: 1.36)
                      .copyWith(leadingDistribution: TextLeadingDistribution.even)),
            ]),
          ),
          if (lit)
            Positioned(
              top: 22,
              right: 22,
              child: RepaintBoundary(
                child: FadeTransition(
                  opacity: pulse,
                  child: Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                        color: ink, shape: BoxShape.circle, boxShadow: [cssShadow(ink, blur: 10)]),
                  ),
                ),
              ),
            ),
        ]),
      ),
    );
  }

  Widget _head(Notice n, Color ink, bool lit) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(n.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Face.s(23, weight: FontWeight.w600, color: lit ? ink : ink.withValues(alpha: 0.75))),
        const SizedBox(height: 4),
        Row(children: [
          if (hasAppIcon(n.app)) ...[AppIcon(n.app, size: 22), const SizedBox(width: 8)],
          Text(kindWord(n.kind), style: Face.s(17, color: Ink.dim)),
          const SizedBox(width: 8),
          Flexible(
            child: Text(agoText(now, n.at),
                maxLines: 1, overflow: TextOverflow.ellipsis, style: Face.s(17, color: Ink.faint)),
          ),
        ]),
      ]);
}
