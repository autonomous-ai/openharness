import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/daemons/card.dart';
import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/plates.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';

import 'daemon_consent.dart';
import 'daemon_plate.dart';
import 'daemon_style.dart';

/// Open [egg] on the server and show the reveal over everything. The chip
/// keeps the egg until the reveal has named the hatchling (or was closed),
/// and the daemon then arrives with a slow blink. The account's first daemon
/// then asks whether it may watch.
Future<void> hatchEgg(
  NavigatorState navigator,
  DaemonFace face,
  ZooEgg egg,
) async {
  final zoo = face.zoo;
  if (zoo.hatchingEgg != null) return;
  face.beginReveal();
  final first = zoo.zoo.daemons.isEmpty;
  final result = zoo.hatch(egg.id);
  try {
    await navigator.push(
      PageRouteBuilder<void>(
        opaque: true,
        fullscreenDialog: true,
        transitionDuration: const Duration(milliseconds: 180),
        reverseTransitionDuration: const Duration(milliseconds: 180),
        transitionsBuilder: (context, animation, _, child) =>
            FadeTransition(opacity: animation, child: child),
        pageBuilder: (context, _, _) => DaemonHatchReveal(
          roster: face.roster,
          egg: egg,
          result: result,
          zoo: zoo,
          onRevealed: face.endReveal,
          askConsent: first,
        ),
      ),
    );
  } finally {
    face.endReveal();
  }
}

/// Where the reveal is. Exposed so tests and review captures can draw any
/// moment of it.
enum HatchStage {
  egg,
  pitch,
  silhouette,
  colour,
  banner,
  card,
  consent,
  failed,
}

/// A still of the reveal, for review captures.
@immutable
class HatchFrame {
  const HatchFrame({
    required this.stage,
    this.egg,
    this.sprite,
    this.bannerRows = 0,
    this.faint,
    this.version,
  });
  final HatchStage stage;
  final String? egg, sprite;
  final int bannerRows;

  /// The sprite in the faint colour: a silhouette's, or a level-up morph's
  /// first two frames. Defaults to the silhouette stage.
  final bool? faint;

  /// The version the hatchling is drawn at (an index into the roster's
  /// versions): a filled daemon's plate is drawn from it, not from [sprite].
  /// Defaults to the version it hatched at.
  final int? version;
}

/// The hatch reveal, full screen (`daemons/README.md`, Hatching): the egg
/// wobbles twice (and keeps wobbling while the server answers), cracks — with
/// a tap of haptics — and its top pops; the 0.1 sprite appears as `#` in the
/// faint colour for 850 ms, fills with its colour (its shiny colour when the
/// hatch is shiny) and blinks; its name types in, a row at a time, as a
/// banner in the face from `daemons/banner.json` ([renderBanner]); the rarity
/// stamp and first words appear; then the card, which copies as a fenced code
/// block and carries the new daemon's serial. A secret's reveal starts pitch
/// black; the grue, who shows only in the dark, stays there. Reduce Motion goes
/// straight to the card.
///
/// A daemon drawn filled (drop `init`) hatches as its plate instead of its
/// sprite: the plate's `#` shape, then the plate in its colours, looping a
/// frame every `frameMs` from then on ([DaemonPlateView]) — at `reveal` size
/// where the screen is wide enough, else its portrait plate scaled to fit
/// ([revealPlateFit]). A plate has no lid to blink.
///
/// A duplicate has no name to reveal and no card of its own: it is a fork of
/// the one you have, drawn at its version, and after the colour it says what
/// it merged into (`tim x2 · +150 xp`, and `now shiny` when a shiny one made
/// yours shiny), then any level it reached. A level that reached a new
/// version morphs the sprite into it in three quick frames ([versionMorph]);
/// Reduce Motion shows the new one straight away.
///
/// The account's first daemon ([askConsent]) is followed, after its card's
/// Done, by the consent screen ([DaemonConsent]) unless the person already
/// said yes: "Let it watch" sends `zoo.consent { watching: true }`, "Not now"
/// sends nothing.
///
/// It can be closed at any moment; [onRevealed] runs once, when the daemon
/// may be named elsewhere.
class DaemonHatchReveal extends StatefulWidget {
  const DaemonHatchReveal({
    super.key,
    required this.roster,
    required this.egg,
    required this.result,
    required this.zoo,
    this.onRevealed,
    this.still,
    this.askConsent = false,
  });

  final DaemonRoster roster;
  final ZooEgg egg;
  final Future<ZooHatch?> result;

  /// The zoo, for the hatchling's date.
  final ZooClient zoo;
  final VoidCallback? onRevealed;

  /// Draw one fixed moment instead of running (tests and captures only).
  final HatchFrame? still;

  /// This is the account's first daemon: after its card, ask whether it may
  /// watch.
  final bool askConsent;

  @override
  State<DaemonHatchReveal> createState() => _DaemonHatchRevealState();
}

class _DaemonHatchRevealState extends State<DaemonHatchReveal> {
  /// The banner's type: 18pt cells fit a 25-column name (270pt at a
  /// monospace face's 0.6em advance) inside the 280pt a 320pt-wide screen
  /// leaves between the reveal's margins: seven of drop init's ten, lynx the
  /// widest at 23. A wider face or a wider name (mutt 28, gopher 38, beastie
  /// 39; the held drops' up to fortune's 43) is scaled down whole to fit,
  /// never wrapped.
  static const _bannerSize = 18.0;
  static const _bannerHeight = 1.15;

  /// A level-up waits this long, for its line to be read, then morphs.
  static const morphAfter = Duration(milliseconds: 600);

  /// Each of the morph's three quick frames.
  static const morphFrame = Duration(milliseconds: 110);

  HatchStage _stage = HatchStage.egg;
  late String _egg = eggFrame(widget.roster);
  String? _sprite;

  /// The version [_sprite] is drawn at, for a screen reader.
  int _version = 0;
  bool _faint = false;
  int _bannerRows = 0;
  ZooHatch? _hatch;
  bool _closed = false, _revealed = false, _started = false;
  bool _reduceMotion = false;
  String? _note;

  DaemonRoster get roster => widget.roster;
  DaemonDef? get _def => roster.byId(_hatch?.daemonId);

  @override
  void initState() {
    super.initState();
    final still = widget.still;
    if (still == null) return;
    _started = true;
    _stage = still.stage;
    _egg = still.egg ?? _egg;
    _sprite = still.sprite;
    _faint = still.faint ?? still.stage == HatchStage.silhouette;
    _bannerRows = still.bannerRows;
    unawaited(
      widget.result.then((hatch) {
        if (mounted) {
          setState(() {
            _hatch = hatch;
            _version = still.version ?? _from(hatch);
          });
        }
      }),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (!_started) {
      _started = true;
      unawaited(_run());
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }

  Future<bool> _wait(int ms) async {
    if (_reduceMotion) return !_closed && mounted;
    await Future<void>.delayed(Duration(milliseconds: ms));
    return !_closed && mounted;
  }

  /// The version a hatchling is drawn at: 0.1, or for a duplicate the version
  /// the one it forked from had.
  int _from(ZooHatch? hatch) => hatch != null && hatch.duplicate
      ? roster.versionIndex(hatch.versionBefore)
      : 0;

  void _show(VoidCallback change) {
    if (_closed || !mounted) return;
    setState(change);
  }

  Future<void> _run() async {
    var answered = false;
    unawaited(
      widget.result.then(
        (_) => answered = true,
        onError: (_) => answered = true,
      ),
    );
    // The egg wobbles twice, and keeps wobbling while the server answers.
    var wobbles = 0;
    while (!_reduceMotion && (wobbles < 2 || !answered)) {
      for (final offset in const [-1, 0, 1, 0]) {
        _show(() => _egg = eggFrame(roster, offset: offset));
        if (!await _wait(90)) return;
      }
      if (!await _wait(420)) return;
      wobbles++;
      if (wobbles > 40) break;
    }
    ZooHatch? hatch;
    try {
      hatch = await widget.result;
    } catch (_) {
      hatch = null;
    }
    if (_closed || !mounted) return;
    if (hatch == null || roster.byId(hatch.daemonId) == null) {
      _show(() => _stage = HatchStage.failed);
      return;
    }
    _hatch = hatch;
    if (!_reduceMotion) {
      // Crack, shake, crack wider, pop.
      unawaited(HapticFeedback.mediumImpact());
      _show(() => _egg = eggFrame(roster, crack: 1));
      if (!await _wait(450)) return;
      for (final offset in const [-1, 1, -1, 1, 0]) {
        _show(() => _egg = eggFrame(roster, offset: offset, crack: 1));
        if (!await _wait(60)) return;
      }
      unawaited(HapticFeedback.mediumImpact());
      _show(() => _egg = eggFrame(roster, crack: 2));
      if (!await _wait(520)) return;
      _show(() => _egg = eggPopFrame(roster));
      if (!await _wait(480)) return;
    }
    final def = _def!;
    final from = _from(hatch);
    final sprite = renderSprite(roster, def, from, DaemonMood.idle);
    // A level-up that reached a new version: the sprite it grows into.
    final grows = hatch.duplicate && hatch.grewVersion;
    final to = grows ? roster.versionIndex(hatch.levelUp!.version) : from;
    final grown = renderSprite(roster, def, to, DaemonMood.idle);
    _version = from;
    if (!_reduceMotion) {
      if (def.darkOnly || def.secret) {
        _show(() => _stage = HatchStage.pitch);
        if (!await _wait(1600)) return;
      }
      _show(() {
        _stage = HatchStage.silhouette;
        _sprite = silhouette(sprite);
        _faint = true;
      });
      if (!await _wait(850)) return;
      _show(() {
        _stage = HatchStage.colour;
        _sprite = sprite;
        _faint = false;
      });
      if (!await _wait(320)) return;
      // A plate has no lid: it only blinks if its loop does.
      if (!def.plate) {
        _show(
          () => _sprite = renderSprite(
            roster,
            def,
            from,
            DaemonMood.idle,
            lid: def.lid ?? '-',
          ),
        );
      }
      if (!await _wait(120)) return;
      _show(() => _sprite = sprite);
      if (!await _wait(220)) return;
      final rows = hatch.duplicate
          ? 0
          : renderBanner(daemonBanner, def.id).length;
      for (var row = 1; row <= rows; row++) {
        _show(() {
          _stage = HatchStage.banner;
          _bannerRows = row;
        });
        if (!await _wait(90)) return;
      }
    }
    _show(() {
      _stage = HatchStage.card;
      // Reduce Motion: straight to the version it grew into.
      _sprite = _reduceMotion ? grown : sprite;
      _version = _reduceMotion ? to : from;
      _faint = false;
      _bannerRows = hatch!.duplicate
          ? 0
          : renderBanner(daemonBanner, def.id).length;
    });
    _markRevealed();
    if (!grows || _reduceMotion) return;
    // The level-up, once its line has been read: three quick frames.
    if (!await _wait(morphAfter.inMilliseconds)) return;
    final frames = versionMorph(sprite, grown);
    for (final (i, frame) in frames.indexed) {
      if (i > 0 && !await _wait(morphFrame.inMilliseconds)) return;
      final last = i == frames.length - 1;
      _show(() {
        _sprite = frame;
        _faint = !last;
        // The old shape, then the new one's (a plate is drawn from this).
        _version = i == 0 ? from : to;
      });
    }
  }

  void _markRevealed() {
    if (_revealed) return;
    _revealed = true;
    widget.onRevealed?.call();
  }

  void _close() {
    if (_closed) return;
    _closed = true;
    _markRevealed();
    Navigator.of(context).maybePop();
  }

  /// Done on the card: the first daemon asks whether it may watch, unless the
  /// person already said yes (on any device).
  void _done() {
    final hatch = _hatch;
    if (widget.askConsent &&
        _stage == HatchStage.card &&
        hatch != null &&
        !hatch.duplicate &&
        !widget.zoo.zoo.watching) {
      setState(() => _stage = HatchStage.consent);
      return;
    }
    _close();
  }

  /// The hatchling's name: its nickname, else its id.
  String get _name {
    final id = _hatch?.daemonId ?? '';
    return widget.zoo.zoo.daemon(id)?.nickname ?? id;
  }

  /// The new daemon's serial, from the hatch or the zoo it answered.
  int? get _serial =>
      _hatch?.serial ?? widget.zoo.zoo.daemon(_hatch?.daemonId)?.serial;

  /// The new daemon's card: never a duplicate's, which has no card of its own.
  List<String>? get _card {
    final def = _def, hatch = _hatch;
    if (def == null || hatch == null || hatch.duplicate) return null;
    final born = widget.zoo.zoo.daemon(def.id);
    final now = DateTime.now();
    final today =
        '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
    return cardLines(
      roster,
      def,
      version: roster.rules.versions.first,
      shiny: hatch.shiny,
      serial: _serial,
      hatched: born?.hatchedDay ?? today,
      egg: widget.egg.kind,
    );
  }

  /// What a duplicate merged into: `tim x2 · +150 xp · now shiny`.
  String _merged(DaemonDef def, ZooHatch hatch) {
    final name = widget.zoo.zoo.daemon(def.id)?.nickname ?? def.id;
    return '$name x${hatch.count} · +${hatch.xp} xp'
        '${hatch.becameShiny ? ' · now shiny' : ''}';
  }

  /// The level it reached: `level up · bond 2/4 · now tim 1.0`.
  String? _levelled(DaemonDef def, ZooHatch hatch) {
    final up = hatch.levelUp;
    if (up == null) return null;
    final last = roster.rules.bondLevels.length - 1;
    return 'level up · bond ${up.level}/$last'
        '${hatch.grewVersion ? ' · now ${def.id} ${up.version}' : ''}';
  }

  Future<void> _share() async {
    final card = _card;
    if (card == null) return;
    try {
      await Clipboard.setData(ClipboardData(text: fencedCard(card)));
      if (mounted) {
        setState(() => _note = 'Copied as a code block. Paste it anywhere.');
      }
    } catch (_) {
      if (mounted) setState(() => _note = 'Could not copy the card.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final def = _def;
    final pitch =
        _stage == HatchStage.pitch ||
        (def?.darkOnly == true &&
            _stage != HatchStage.failed &&
            _stage != HatchStage.egg);
    return PopScope(
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) _markRevealed();
      },
      child: Scaffold(
        key: const ValueKey('daemon-hatch'),
        backgroundColor: pitch ? DaemonInk.pitch : DaemonInk.deep,
        body: SafeArea(
          child: Stack(
            children: [
              Positioned.fill(
                child: LayoutBuilder(
                  builder: (context, constraints) => SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(20, 56, 20, 24),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        minHeight: (constraints.maxHeight - 80).clamp(
                          0,
                          double.infinity,
                        ),
                      ),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: _children(pitch),
                      ),
                    ),
                  ),
                ),
              ),
              Positioned(
                top: 4,
                right: 4,
                child: IconButton(
                  key: const ValueKey('daemon-hatch-close'),
                  tooltip: 'Close',
                  onPressed: _close,
                  icon: const Icon(Icons.close, color: DaemonInk.dim),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _art(String text, TextStyle style, {Key? key, String? semantics}) =>
      Semantics(
        label: semantics,
        excludeSemantics: semantics != null,
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(
            text,
            key: key,
            softWrap: false,
            textScaler: TextScaler.noScaling,
            style: style,
          ),
        ),
      );

  /// The name as a banner, [shown] rows of it typed in so far. The whole
  /// banner is laid out from the first row, unseen, so the reveal neither
  /// jumps nor rescales as the rest arrive.
  Widget _banner(List<String> rows, int shown, String name) {
    final style = DaemonInk.mono(
      size: _bannerSize,
      color: DaemonInk.bright,
      height: _bannerHeight,
    );
    Widget text(String data, {Key? key}) => Text(
      data,
      key: key,
      softWrap: false,
      textScaler: TextScaler.noScaling,
      style: style,
    );
    return Semantics(
      label: name,
      excludeSemantics: true,
      child: FittedBox(
        fit: BoxFit.scaleDown,
        child: Stack(
          children: [
            Visibility(
              visible: false,
              maintainSize: true,
              maintainAnimation: true,
              maintainState: true,
              child: text(rows.join('\n')),
            ),
            text(
              rows.take(shown).join('\n'),
              key: const ValueKey('daemon-hatch-banner'),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _children(bool pitch) {
    final def = _def;
    if (_stage == HatchStage.failed) {
      return [
        Semantics(
          liveRegion: true,
          child: Text(
            'The egg did not open.',
            key: const ValueKey('daemon-hatch-failed'),
            textAlign: TextAlign.center,
            style: DaemonInk.sans(
              size: 20,
              color: DaemonInk.bright,
              weight: FontWeight.w600,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'The zoo could not be reached. The egg is still in your nest.',
          textAlign: TextAlign.center,
          style: DaemonInk.sans(size: 15, color: DaemonInk.dim),
        ),
        const SizedBox(height: 20),
        _button('Close', _close, key: const ValueKey('daemon-hatch-done')),
      ];
    }
    if (_stage == HatchStage.egg || def == null) {
      return [
        _art(
          _egg,
          DaemonInk.mono(size: 22, color: DaemonInk.yellow, height: 1.15),
          key: const ValueKey('daemon-hatch-egg'),
          semantics: 'An egg, hatching',
        ),
      ];
    }
    final hatch = _hatch!;
    final colour = def.colorFor(shiny: hatch.shiny);
    if (_stage == HatchStage.consent) {
      return [
        DaemonConsent(
          name: _name,
          sprite: _sprite,
          colour: colour,
          onWatch: () {
            widget.zoo.consent(watching: true);
            _close();
          },
          onNotNow: _close,
        ),
      ];
    }
    final rows = renderBanner(daemonBanner, def.id);
    final card = _stage == HatchStage.card ? _card : null;
    final words = hatch.duplicate
        ? 'fork() returned 0. another ${def.id}.'
        : "fork() returned 0. it's a ${def.id}.\n"
              '${def.id} ${roster.rules.versions.first}: ${def.first}';
    final levelled = _levelled(def, hatch);
    return [
      if (pitch)
        Padding(
          padding: const EdgeInsets.only(bottom: 20),
          child: Text(
            def.darkOnly
                ? 'It is pitch black. You are likely to be eaten by a grue.'
                : 'It is pitch black.',
            key: const ValueKey('daemon-hatch-pitch'),
            textAlign: TextAlign.center,
            style: DaemonInk.mono(size: 14, color: DaemonInk.dim, height: 1.4),
          ),
        ),
      if (_sprite != null && def.plate)
        _plate(def, hatch.shiny, pitch)
      else if (_sprite != null)
        _art(
          _sprite!,
          DaemonInk.mono(
            size: 44,
            height: 1,
            weight: FontWeight.w600,
            color: _faint ? _faintInk : colour,
          ),
          key: const ValueKey('daemon-hatch-sprite'),
          semantics: _hatchlingLabel(def),
        ),
      if (_bannerRows > 0) ...[
        const SizedBox(height: 18),
        _banner(rows, _bannerRows, def.id),
      ],
      if (_stage == HatchStage.card) ...[
        const SizedBox(height: 18),
        Text(
          rarityStamp(roster, def, shiny: hatch.shiny),
          key: const ValueKey('daemon-hatch-stamp'),
          textAlign: TextAlign.center,
          style: DaemonInk.mono(
            size: 13,
            color: DaemonInk.rarity(def.rarity),
          ).copyWith(letterSpacing: 1.2),
        ),
        const SizedBox(height: 10),
        Semantics(
          liveRegion: true,
          child: Text(
            words,
            key: const ValueKey('daemon-hatch-words'),
            textAlign: TextAlign.center,
            style: DaemonInk.mono(
              size: 13.5,
              color: DaemonInk.dim,
              height: 1.45,
            ),
          ),
        ),
        if (hatch.duplicate) ...[
          const SizedBox(height: 14),
          Semantics(
            liveRegion: true,
            child: Text(
              _merged(def, hatch),
              key: const ValueKey('daemon-hatch-merged'),
              textAlign: TextAlign.center,
              style: DaemonInk.mono(
                size: 15,
                color: def.colorFor(shiny: hatch.shiny || hatch.becameShiny),
                weight: FontWeight.w600,
                height: 1.4,
              ),
            ),
          ),
        ],
        if (levelled != null) ...[
          const SizedBox(height: 8),
          Text(
            levelled,
            key: const ValueKey('daemon-hatch-level'),
            textAlign: TextAlign.center,
            style: DaemonInk.mono(
              size: 13.5,
              color: DaemonInk.ink,
              height: 1.4,
            ),
          ),
        ],
        if (hatch.duplicate) ...[
          const SizedBox(height: 20),
          _button('Done', _done, key: const ValueKey('daemon-hatch-done')),
        ],
        if (card != null) ...[
          const SizedBox(height: 20),
          DaemonCardView(
            key: const ValueKey('daemon-hatch-card'),
            roster: roster,
            def: def,
            lines: card,
            version: roster.rules.versions.first,
            shiny: hatch.shiny,
            serial: _serial,
            ground: pitch ? const Color(0xFF0C0C0C) : DaemonInk.ground,
          ),
          const SizedBox(height: 16),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 12,
            runSpacing: 8,
            children: [
              _button(
                'Share card',
                _share,
                key: const ValueKey('daemon-hatch-share'),
                hint: 'Copies the card as a code block',
                filled: true,
              ),
              _button('Done', _done, key: const ValueKey('daemon-hatch-done')),
            ],
          ),
          const SizedBox(height: 10),
          Semantics(
            liveRegion: true,
            child: Text(
              _note ?? ' ',
              key: const ValueKey('daemon-hatch-note'),
              textAlign: TextAlign.center,
              style: DaemonInk.sans(size: 13.5, color: DaemonInk.dim),
            ),
          ),
        ],
      ],
    ];
  }

  /// The silhouette's colour, and a morph's first two frames'.
  static final _faintInk = DaemonInk.ink.withValues(alpha: .35);

  String _hatchlingLabel(DaemonDef def) => _stage == HatchStage.silhouette
      ? 'A silhouette'
      : _faint
      ? '${def.id}, growing'
      : '${def.id} ${roster.rules.versions[_version]}';

  /// A filled daemon's hatchling: its plate's `#` shape while faint, else the
  /// plate in its colours, looping; at the size [revealPlateFit] picks for the
  /// width.
  Widget _plate(DaemonDef def, bool shiny, bool pitch) => LayoutBuilder(
    builder: (context, constraints) {
      final fit = revealPlateFit(roster, constraints.maxWidth);
      final version = roster.rules.versions[_version];
      return Semantics(
        label: _hatchlingLabel(def),
        image: true,
        excludeSemantics: true,
        child: Center(
          child: DaemonPlateView(
            key: ValueKey(
              _faint ? 'daemon-hatch-sprite' : 'daemon-hatch-plate',
            ),
            roster: roster,
            def: def,
            size: fit.size,
            version: version,
            shiny: shiny,
            ground: pitch ? DaemonInk.pitch : DaemonInk.deep,
            fontSize: fit.fontSize,
            asSilhouette: _faint,
            faint: _faintInk,
          ),
        ),
      );
    },
  );

  Widget _button(
    String label,
    VoidCallback onPressed, {
    Key? key,
    String? hint,
    bool filled = false,
  }) => DaemonButton(label, onPressed, key: key, hint: hint, filled: filled);
}

/// A card as it is drawn on the phone: its lines in their columns, scaled to
/// fit and never wrapped, the head in its rarity's colour and the portrait in
/// the daemon's (its shiny one when it is shiny), as card.mjs's `cardSvg`
/// colours them. A filled daemon's portrait plate runs down its gradient, each
/// glyph in its plate colour on [ground]. The words stay ink.
class DaemonCardView extends StatelessWidget {
  const DaemonCardView({
    super.key,
    required this.roster,
    required this.def,
    required this.lines,
    required this.version,
    required this.shiny,
    this.serial,
    this.ground = DaemonInk.ground,
  });

  final DaemonRoster roster;
  final DaemonDef def;
  final List<String> lines;
  final String version;
  final bool shiny;

  /// Its mint number, for a screen reader; the lines already carry it.
  final int? serial;
  final Color ground;

  /// The card's text, for tests and the clipboard.
  String get text => lines.join('\n');

  @override
  Widget build(BuildContext context) {
    final portrait = cardPortraitRows(roster, def, version);
    final colour = def.colorFor(shiny: shiny);
    final plate = def.plate && def.gradient != null
        ? PlatePalette.of(
            roster,
            def,
            portrait.to - portrait.from,
            ground: ground,
            shiny: shiny,
          )
        : null;
    Color? rowColour(int i) => i == 1
        ? DaemonInk.rarity(def.rarity)
        : i >= portrait.from && i < portrait.to
        ? colour
        : null;
    InlineSpan line(int i) {
      final text = i == lines.length - 1 ? lines[i] : '${lines[i]}\n';
      if (plate == null || i < portrait.from || i >= portrait.to) {
        final c = rowColour(i);
        return TextSpan(
          text: text,
          style: c == null ? null : TextStyle(color: c),
        );
      }
      // The frame `| ` and ` |` stays ink; every glyph inside is the plate's.
      final r = i - portrait.from;
      final spans = <TextSpan>[];
      final run = StringBuffer();
      Color? at;
      void flush() {
        if (run.isEmpty) return;
        spans.add(
          TextSpan(
            text: run.toString(),
            style: at == null ? null : TextStyle(color: at),
          ),
        );
        run.clear();
      }

      for (var c = 0; c < text.length; c++) {
        final inside = c >= 2 && c < cardWidth - 2;
        final next = inside ? plate.at(r, text[c]) : null;
        if (next != at && (next != null || !inside || text[c] != ' ')) {
          flush();
          at = next;
        }
        run.write(text[c]);
      }
      flush();
      return TextSpan(children: spans);
    }

    return Semantics(
      label:
          'The card: ${def.id}, ${shiny ? 'shiny ' : ''}${def.rarity}'
          '${serial == null ? '' : ', ${serialLabel(serial!)}'}',
      excludeSemantics: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: ground,
          border: Border.all(color: DaemonInk.line),
          borderRadius: BorderRadius.circular(6),
        ),
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: Text.rich(
            TextSpan(
              children: [for (var i = 0; i < lines.length; i++) line(i)],
            ),
            softWrap: false,
            textScaler: TextScaler.noScaling,
            style: DaemonInk.mono(
              size: 12.5,
              color: DaemonInk.ink,
              height: 1.2,
            ),
          ),
        ),
      ),
    );
  }
}
