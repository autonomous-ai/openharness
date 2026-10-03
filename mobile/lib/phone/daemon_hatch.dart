import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/daemons/card.dart';
import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/individual_art.dart';
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
  ZooEgg egg, {
  IndividualArt? art,
}) async {
  final zoo = face.zoo;
  if (zoo.hatchingEgg != null) return;
  face.beginReveal(kind: egg.kind);
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
          art: art,
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
  /// The ready egg peeks and blinks while the server draws.
  egg,

  /// Two big rocks.
  rock,

  /// The top lifts and light pours out, the rarity's; a secret's goes dark.
  burst,

  /// The top breaks in two, the halves land either side, bits scatter.
  tumble,

  /// The bottom half, empty.
  open,

  /// The hatchling rises out of it as `#`, a row at a time.
  rising,

  /// Risen: its `#` shape holds.
  silhouette,

  /// It fills with its colour, and blinks.
  colour,

  /// Its name types in as a banner.
  banner,

  /// The stamp, its flags and rarity, first words, its card and the name
  /// prompt.
  card,
  consent,
  failed,
}

/// The egg stage each opening stage of the reveal draws.
const _eggStageOf = {
  HatchStage.egg: 'p4',
  HatchStage.rock: 'rock',
  HatchStage.burst: 'burst',
  HatchStage.tumble: 'tumble',
  HatchStage.open: 'open',
};

/// A still of the reveal, for review captures.
@immutable
class HatchFrame {
  const HatchFrame({
    required this.stage,
    this.eggFrame = 0,
    this.risen,
    this.sprite,
    this.bannerRows = 0,
    this.faint,
    this.version,
    this.name,
  });
  final HatchStage stage;

  /// The frame of the egg's stage drawn (egg to open).
  final int eggFrame;

  /// Rows of the hatchling risen out of its shell (rising); all of them when
  /// null.
  final int? risen;
  final String? sprite;
  final int bannerRows;

  /// The sprite in the faint colour: a silhouette's, or a level-up morph's
  /// first two frames. Defaults to the rising and silhouette stages.
  final bool? faint;

  /// The version the hatchling is drawn at (an index into the roster's
  /// versions): a filled daemon's plate is drawn from it, not from [sprite].
  /// Defaults to the version it hatched at.
  final int? version;

  /// What has been typed into the name prompt.
  final String? name;
}

/// The hatch reveal, full screen (`daemons/README.md`, Eggs and Hatching). The
/// ready egg — its kind's filled plate — peeks and blinks while the server
/// draws; then it rocks twice, bursts in its rarity's light (a secret's goes
/// dark: the stage turns black, the shell dims, only the violet light shows),
/// its top tumbles off in two halves, and the bottom half stands open. The
/// hatchling rises out of it a row at a time as `#` in the faint colour,
/// holds 850 ms, fills with its colour — an individual's own colour family,
/// and its own art once harnessd has drawn it — and blinks; its name types in
/// as a banner in the face from `daemons/banner.json` ([renderBanner]); the
/// rarity stamp, its flags and how rare it is (`1 in 644`) and first words
/// appear; then its card, which copies as a fenced code block, and a prompt
/// for its name (optional: Done without one skips it). Reduce Motion shows
/// the waiting egg's first frame and goes straight to the card.
///
/// A daemon drawn filled (drop `init`) is its plate throughout, at `reveal`
/// size where the screen is wide enough, else its portrait plate scaled to
/// fit ([revealPlateFit]), the egg at the same size. A plate has no lid to
/// blink. A line-art daemon (a held drop) rises as its sprite.
///
/// From a server before individuals, a duplicate has no name to reveal and
/// no card of its own: it is drawn at its version, and after the colour it
/// says what it merged into (`tim x2 · +150 xp`, and `now shiny` when a
/// shiny one made yours shiny), then any level it reached. A level that
/// reached a new version morphs the sprite into it in three quick frames
/// ([versionMorph]); Reduce Motion shows the new one straight away.
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
    this.art,
    this.onRevealed,
    this.still,
    this.askConsent = false,
  });

  final DaemonRoster roster;
  final ZooEgg egg;
  final Future<ZooHatch?> result;

  /// The zoo, for the hatchling's date, serial and name.
  final ZooClient zoo;

  /// Where the individual's own plates come from; null draws its species
  /// plate in its colours.
  final IndividualArt? art;
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

  /// The hatchling rises a row every this long.
  static const riseRow = Duration(milliseconds: 45);

  HatchStage _stage = HatchStage.egg;
  int _eggFrame = 0;

  /// Rows of the hatchling risen out of its shell; null is all of them.
  int? _risen;
  String? _sprite;

  /// The version [_sprite] is drawn at, for a screen reader.
  int _version = 0;
  bool _faint = false;
  int _bannerRows = 0;
  ZooHatch? _hatch;
  bool _closed = false, _revealed = false, _started = false;
  bool _reduceMotion = false;
  String? _note;
  final _name = TextEditingController();

  /// The size the egg and the hatchling were last laid out at.
  PlateSize _size = PlateSize.reveal;

  DaemonRoster get roster => widget.roster;
  DaemonDef? get _def => roster.byId(_hatch?.daemonId);

  @override
  void initState() {
    super.initState();
    widget.art?.addListener(_artArrived);
    _name.addListener(_typed);
    final still = widget.still;
    if (still == null) return;
    _started = true;
    _stage = still.stage;
    _eggFrame = still.eggFrame;
    _risen = still.risen;
    _sprite = still.sprite;
    _faint =
        still.faint ??
        (still.stage == HatchStage.silhouette ||
            still.stage == HatchStage.rising);
    _bannerRows = still.bannerRows;
    _name.text = still.name ?? '';
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
    widget.art?.removeListener(_artArrived);
    _name.dispose();
    super.dispose();
  }

  void _artArrived() {
    if (mounted) setState(() {});
  }

  /// The card follows the name as it is typed.
  void _typed() {
    if (mounted && _stage == HatchStage.card) setState(() {});
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

  /// Every frame of one opening [stage], each held [ms] of its index.
  Future<bool> _playEgg(HatchStage stage, int Function(int frame) ms) async {
    final count = daemonPlates
        .egg(widget.egg.kind, _size, _eggStageOf[stage]!)
        .length;
    for (var i = 0; i < (count == 0 ? 1 : count); i++) {
      _show(() {
        _stage = stage;
        _eggFrame = i;
      });
      if (!await _wait(ms(i))) return false;
    }
    return true;
  }

  Future<void> _run() async {
    var answered = false;
    unawaited(
      widget.result.then(
        (_) => answered = true,
        onError: (_) => answered = true,
      ),
    );
    final eggMs = roster.rules.plate?.eggMs;
    final loop = eggMs?.loop ?? 190;
    // The ready egg peeks and blinks: once through, and on while the server
    // answers.
    var passes = 0;
    while (!_reduceMotion && (passes < 1 || !answered)) {
      if (!await _playEgg(HatchStage.egg, (_) => loop)) return;
      passes++;
      if (passes > 40) break;
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
    _prefetch(hatch);
    final def = _def!;
    final from = _from(hatch);
    String spriteAt(int v, {String? lid}) => renderIndividualSprite(
      roster,
      def.id,
      _traits,
      v,
      DaemonMood.idle,
      lid: lid,
    );
    final sprite = spriteAt(from);
    // A level-up that reached a new version: the sprite it grows into.
    final grows = hatch.duplicate && hatch.grewVersion;
    final to = grows ? roster.versionIndex(hatch.levelUp!.version) : from;
    final grown = spriteAt(to);
    _version = from;
    if (!_reduceMotion) {
      // Two big rocks, the burst in its light, the top tumbling off.
      unawaited(HapticFeedback.mediumImpact());
      for (var pass = 0; pass < 2; pass++) {
        if (!await _playEgg(HatchStage.rock, (_) => eggMs?.rock ?? 65)) {
          return;
        }
      }
      unawaited(HapticFeedback.heavyImpact());
      final burst = await _playEgg(
        HatchStage.burst,
        (i) => i == 0 ? eggMs?.burstHold ?? 420 : eggMs?.burst ?? 150,
      );
      if (!burst) return;
      if (!await _playEgg(HatchStage.tumble, (_) => eggMs?.tumble ?? 75)) {
        return;
      }
      if (!await _playEgg(HatchStage.open, (_) => eggMs?.open ?? 380)) return;
      // It rises out of the bottom half, a row at a time, as its shape.
      final rows = _hatchlingRows(def);
      _sprite = silhouette(sprite);
      for (var row = 1; row <= rows; row++) {
        _show(() {
          _stage = HatchStage.rising;
          _risen = row;
          _faint = true;
        });
        if (!await _wait(riseRow.inMilliseconds)) return;
      }
      _show(() {
        _stage = HatchStage.silhouette;
        _risen = null;
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
        _show(() => _sprite = spriteAt(from, lid: def.lid ?? '-'));
      }
      if (!await _wait(120)) return;
      _show(() => _sprite = sprite);
      if (!await _wait(220)) return;
      final banner = hatch.duplicate
          ? 0
          : renderBanner(daemonBanner, def.id).length;
      for (var row = 1; row <= banner; row++) {
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
      _risen = null;
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

  /// How many rows the hatchling rises through: its plate's (its own art's
  /// once it is here), or one for a sprite.
  int _hatchlingRows(DaemonDef def) {
    if (!def.plate) return 1;
    final version = roster.rules.versions[_version];
    final own = _art(_size, version);
    if (own != null && own.isNotEmpty) return own.first.rows.length;
    return daemonPlates.still(def.id, _size, version).length;
  }

  /// Ask harnessd for the new individual's plates now, before the reveal
  /// and its card need them.
  void _prefetch(ZooHatch hatch) {
    final art = widget.art, born = _individual;
    if (art == null || born == null) return;
    final version = roster.rules.versions[_from(hatch)];
    for (final size in PlateSize.values) {
      art.prefetch(born, size, version);
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

  /// Done on the card: the name typed, if any, is given; then the first
  /// daemon asks whether it may watch, unless the person already said yes
  /// (on any device).
  void _done() {
    final hatch = _hatch;
    if (_stage == HatchStage.card && hatch != null && !hatch.duplicate) {
      final typed = _name.text.trim();
      if (typed.isNotEmpty) {
        if (!validNickname(typed)) {
          setState(
            () => _note = 'A name is 1 to 24 characters a keyboard types.',
          );
          return;
        }
        final born = _individual;
        if (born != null) widget.zoo.name(born.uid, typed);
      }
    }
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

  /// The individual that hatched: from the zoo the answer brought, else as
  /// the answer named it.
  ZooDaemon? get _individual {
    final hatch = _hatch;
    if (hatch == null) return null;
    final zoo = widget.zoo.zoo;
    final known = zoo.individual(hatch.uid);
    if (known != null) return known;
    if (hatch.duplicate) return zoo.daemon(hatch.daemonId);
    return ZooDaemon(
      uid: hatch.uid,
      id: hatch.daemonId,
      seed: hatch.seed,
      hatchedAt: '',
      egg: widget.egg.kind,
      shiny: hatch.shiny,
      serial: hatch.serial,
    );
  }

  /// Its traits, rolled from its seed.
  DaemonTraits? get _traits => _individual?.traits(roster);

  /// Its own plates at [size] and [version], idle, once harnessd has drawn
  /// them.
  List<PlateFrame>? _art(PlateSize size, String version) {
    final born = _individual, art = widget.art;
    if (born == null || art == null) return null;
    return art.frames(born, size, version);
  }

  /// The name typed so far, when it would be accepted.
  String? get _typedName {
    final typed = _name.text.trim();
    return typed.isNotEmpty && validNickname(typed) ? typed : null;
  }

  /// The new daemon's serial, from the hatch or the zoo it answered.
  int? get _serial => _hatch?.serial ?? _individual?.serial;

  /// The new individual's card: never a duplicate's, which has no card of
  /// its own. It carries the name as it is typed, and its own portrait once
  /// harnessd has drawn it.
  List<String>? get _card {
    final def = _def, hatch = _hatch;
    if (def == null || hatch == null || hatch.duplicate) return null;
    final born = _individual;
    final now = DateTime.now();
    final today =
        '${now.year.toString().padLeft(4, '0')}-'
        '${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')}';
    final version = roster.rules.versions.first;
    final traits = _traits;
    return cardLines(
      roster,
      def,
      version: version,
      shiny: hatch.shiny,
      serial: _serial,
      name: _typedName ?? born?.name,
      traits: traits == null || traits.seed == 0 ? null : traits,
      hatched: born?.hatchedDay ?? today,
      egg: widget.egg.kind,
      plate: _art(PlateSize.portrait, version)?.first.rows,
    );
  }

  /// What a duplicate merged into: `tim x2 · +150 xp · now shiny`.
  String _merged(DaemonDef def, ZooHatch hatch) {
    final name = widget.zoo.zoo.daemon(def.id)?.called ?? def.id;
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

  /// A secret's opening goes dark, from the burst until it takes its colour;
  /// a daemon that lives in the dark (the grue) stays there.
  bool get _pitch {
    final def = _def;
    if (_stage == HatchStage.failed || _stage == HatchStage.egg) return false;
    if (def?.darkOnly == true) return true;
    return def?.secret == true &&
        const {
          HatchStage.burst,
          HatchStage.tumble,
          HatchStage.open,
          HatchStage.rising,
          HatchStage.silhouette,
        }.contains(_stage);
  }

  /// The egg's light as it opens: plain while it waits and rocks, the
  /// rarity's once it bursts; a secret's opening dims the rest.
  ({String light, bool dim}) get _light {
    final def = _def;
    final opened =
        def != null && _stage != HatchStage.egg && _stage != HatchStage.rock;
    if (!opened) return (light: 'plain', dim: false);
    final known = roster.rules.plate?.light.containsKey(def.rarity) == true;
    return (light: known ? def.rarity : 'common', dim: def.secret);
  }

  @override
  Widget build(BuildContext context) {
    final pitch = _pitch;
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

  /// The egg at its stage and frame, at the size the hatchling is drawn at.
  Widget _egg(bool pitch) => LayoutBuilder(
    builder: (context, constraints) {
      final fit = revealPlateFit(roster, constraints.maxWidth);
      _size = fit.size;
      final light = _light;
      return Semantics(
        label: 'An egg, hatching',
        image: true,
        excludeSemantics: true,
        child: Center(
          child: EggPlateView(
            key: const ValueKey('daemon-hatch-egg'),
            roster: roster,
            kind: widget.egg.kind,
            stage: _eggStageOf[_stage] ?? 'p4',
            size: fit.size,
            frame: _eggFrame,
            light: light.light,
            dim: light.dim,
            ground: pitch ? DaemonInk.pitch : DaemonInk.deep,
            fontSize: fit.fontSize,
          ),
        ),
      );
    },
  );

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
    final pitchWords = pitch
        ? Padding(
            padding: const EdgeInsets.only(bottom: 20),
            child: Text(
              def?.darkOnly == true
                  ? 'It is pitch black. You are likely to be eaten by a grue.'
                  : 'It is pitch black.',
              key: const ValueKey('daemon-hatch-pitch'),
              textAlign: TextAlign.center,
              style: DaemonInk.mono(
                size: 14,
                color: DaemonInk.dim,
                height: 1.4,
              ),
            ),
          )
        : null;
    if (_eggStageOf.containsKey(_stage) || def == null) {
      return [?pitchWords, _egg(pitch)];
    }
    final hatch = _hatch!;
    final colour = def.colorFor(shiny: hatch.shiny);
    if (_stage == HatchStage.consent) {
      return [
        DaemonConsent(
          name: _typedName ?? _individual?.called ?? def.id,
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
    final traits = _traits;
    final words = hatch.duplicate
        ? 'fork() returned 0. another ${def.id}.'
        : "fork() returned 0. it's a ${def.id}.\n"
              '${def.id} ${roster.rules.versions.first}: ${def.first}';
    final levelled = _levelled(def, hatch);
    final version = roster.rules.versions.first;
    return [
      ?pitchWords,
      if (_sprite != null)
        // The open shell stays under the hatchling until its card.
        _hatchling(def, hatch.shiny, pitch, shell: _stage != HatchStage.card)
      else
        _egg(pitch),
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
        if (!hatch.duplicate && traits != null && traits.seed != 0) ...[
          const SizedBox(height: 10),
          Text(
            '${individualFlags(roster, def.id, traits)}\n'
            '${oneInText(oneIn(roster, def.id, traits))}',
            key: const ValueKey('daemon-hatch-flags'),
            textAlign: TextAlign.center,
            style: DaemonInk.mono(size: 13.5, color: colour, height: 1.45),
          ),
        ],
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
            version: version,
            shiny: hatch.shiny,
            serial: _serial,
            traits: traits,
            art: _art(PlateSize.portrait, version)?.first,
            ground: pitch ? DaemonInk.deep : DaemonInk.ground,
          ),
          const SizedBox(height: 18),
          _NamePrompt(
            controller: _name,
            species: def.id,
            placeholder: _individual?.title ?? def.id,
            onDone: _done,
          ),
          const SizedBox(height: 12),
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
              ),
              _button(
                _typedName == null ? 'Done' : 'Name it',
                _done,
                key: const ValueKey('daemon-hatch-done'),
                hint: _typedName == null
                    ? 'Keeps it unnamed'
                    : 'Gives it this name on every device',
                filled: true,
              ),
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

  String _hatchlingLabel(DaemonDef def) =>
      _stage == HatchStage.silhouette || _stage == HatchStage.rising
      ? 'A silhouette'
      : _faint
      ? '${def.id}, growing'
      : '${def.id} ${roster.rules.versions[_version]}';

  /// The hatchling: a filled daemon's plate (its `#` shape while faint, risen
  /// [_risen] rows; else in its colours, looping), or a line-art daemon's
  /// sprite; standing in the open bottom half of its shell while [shell].
  Widget _hatchling(
    DaemonDef def,
    bool shiny,
    bool pitch, {
    required bool shell,
  }) => LayoutBuilder(
    builder: (context, constraints) {
      final fit = revealPlateFit(roster, constraints.maxWidth);
      _size = fit.size;
      final version = roster.rules.versions[_version];
      final ground = pitch ? DaemonInk.pitch : DaemonInk.deep;
      final Widget body;
      if (def.plate) {
        body = DaemonPlateView(
          key: ValueKey(_faint ? 'daemon-hatch-sprite' : 'daemon-hatch-plate'),
          roster: roster,
          def: def,
          size: fit.size,
          version: version,
          shiny: shiny,
          ground: ground,
          fontSize: fit.fontSize,
          asSilhouette: _faint,
          faint: _faintInk,
          traits: _traits,
          art: _faint ? null : _art(fit.size, version),
          rowsShown: _risen,
        );
      } else {
        body = Text(
          _sprite!,
          key: const ValueKey('daemon-hatch-sprite'),
          softWrap: false,
          textScaler: TextScaler.noScaling,
          style: DaemonInk.mono(
            size: 44,
            height: 1,
            weight: FontWeight.w600,
            color: _faint ? _faintInk : def.colorFor(shiny: shiny),
          ),
        );
      }
      final kind = widget.egg.kind;
      final light = _light;
      final hasShell =
          shell && daemonPlates.egg(kind, fit.size, 'open').isNotEmpty;
      return Semantics(
        label: _hatchlingLabel(def),
        image: true,
        excludeSemantics: true,
        child: Center(
          child: hasShell
              ? FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      body,
                      EggPlateView(
                        key: const ValueKey('daemon-hatch-shell'),
                        roster: roster,
                        kind: kind,
                        stage: 'open',
                        size: fit.size,
                        frame: 0,
                        light: light.light,
                        dim: light.dim && pitch,
                        ground: ground,
                        fontSize: fit.fontSize,
                        fromRow: eggRim(kind, fit.size),
                      ),
                    ],
                  ),
                )
              : body,
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

/// The name prompt under a new individual's card (README "Hatching": the
/// person names it). Optional: Done without a name keeps it unnamed. The card
/// above follows what is typed.
class _NamePrompt extends StatelessWidget {
  const _NamePrompt({
    required this.controller,
    required this.species,
    required this.placeholder,
    required this.onDone,
  });

  final TextEditingController controller;
  final String species, placeholder;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(
        'Name your $species',
        textAlign: TextAlign.center,
        style: DaemonInk.sans(
          size: 16,
          color: DaemonInk.bright,
          weight: FontWeight.w600,
        ),
      ),
      const SizedBox(height: 2),
      Text(
        'Optional. It goes by it on every device.',
        textAlign: TextAlign.center,
        style: DaemonInk.sans(size: 13.5, color: DaemonInk.dim),
      ),
      const SizedBox(height: 8),
      Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 280),
          child: DaemonNameField(
            key: const ValueKey('daemon-hatch-name'),
            controller: controller,
            placeholder: placeholder,
            onSubmitted: onDone,
          ),
        ),
      ),
    ],
  );
}

/// A daemon's name, typed: 24 printable ASCII characters at most (README,
/// `zoo.nickname`), in the art's monospace, on the night ground.
class DaemonNameField extends StatelessWidget {
  const DaemonNameField({
    super.key,
    required this.controller,
    required this.placeholder,
    required this.onSubmitted,
    this.autofocus = false,
  });

  final TextEditingController controller;
  final String placeholder;
  final VoidCallback onSubmitted;
  final bool autofocus;

  @override
  Widget build(BuildContext context) => TextField(
    controller: controller,
    autofocus: autofocus,
    maxLength: 24,
    textAlign: TextAlign.center,
    textInputAction: TextInputAction.done,
    autocorrect: false,
    enableSuggestions: false,
    inputFormatters: [
      FilteringTextInputFormatter.allow(RegExp(r'[\x20-\x7e]')),
    ],
    onSubmitted: (_) => onSubmitted(),
    cursorColor: DaemonInk.yellow,
    style: DaemonInk.mono(size: 16, color: DaemonInk.bright),
    decoration: InputDecoration(
      hintText: placeholder,
      hintStyle: DaemonInk.mono(size: 16, color: DaemonInk.faint),
      counterStyle: DaemonInk.sans(size: 11, color: DaemonInk.faint),
      isDense: true,
      filled: true,
      fillColor: DaemonInk.deep,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: DaemonInk.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: DaemonInk.yellow),
      ),
    ),
  );
}

/// A card as it is drawn on the phone: its lines in their columns, scaled to
/// fit and never wrapped, the head in its rarity's colour and the portrait in
/// the daemon's (its shiny one when it is shiny), as card.mjs's `cardSvg`
/// colours them. A filled daemon's portrait plate runs down its gradient, each
/// glyph in its plate colour on [ground] — an individual's down its colour
/// family, with its markings, extra and odd eye when it is its own [art]. The
/// words stay ink.
class DaemonCardView extends StatelessWidget {
  const DaemonCardView({
    super.key,
    required this.roster,
    required this.def,
    required this.lines,
    required this.version,
    required this.shiny,
    this.serial,
    this.traits,
    this.art,
    this.ground = DaemonInk.ground,
  });

  final DaemonRoster roster;
  final DaemonDef def;
  final List<String> lines;
  final String version;
  final bool shiny;

  /// Its mint number, for a screen reader; the lines already carry it.
  final int? serial;

  /// The individual's traits (its colour family); null or seed 0 for the
  /// species' own.
  final DaemonTraits? traits;

  /// The individual's own portrait plate frame the lines were drawn with.
  final PlateFrame? art;
  final Color ground;

  /// The card's text, for tests and the clipboard.
  String get text => lines.join('\n');

  @override
  Widget build(BuildContext context) {
    final portrait = cardPortraitRows(roster, def, version, plate: art?.rows);
    final colour = def.colorFor(shiny: shiny);
    final height = portrait.to - portrait.from;
    final own = traits != null && traits!.seed != 0 && def.traits != null;
    Color? Function(int r, int c, String ch)? plate;
    if (def.plate && def.gradient != null) {
      if (own) {
        final palette = CellPalette.individual(
          roster,
          def,
          traits!,
          height,
          ground: ground,
          shiny: shiny,
        );
        // The portrait is centred: a cell's column in the plate is its
        // column on the card less the frame and the padding.
        final width = (art?.rows ?? const <String>[]).fold<int>(
          0,
          (w, l) => l.length > w ? l.length : w,
        );
        final pad = ((cardWidth - 4 - width) / 2).floor();
        plate = (r, c, ch) =>
            palette.at(r, ch, art?.mat(r, c - 2 - pad) ?? '.');
      } else {
        final palette = PlatePalette.of(
          roster,
          def,
          height,
          ground: ground,
          shiny: shiny,
        );
        plate = (r, c, ch) => palette.at(r, ch);
      }
    }
    Color? rowColour(int i) => i == 1
        ? DaemonInk.rarity(def.rarity)
        : i >= portrait.from && i < portrait.to
        ? colour
        : null;
    InlineSpan line(int i) {
      final text = i == lines.length - 1 ? lines[i] : '${lines[i]}\n';
      final paint = plate;
      if (paint == null || i < portrait.from || i >= portrait.to) {
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
        final ch = text[c];
        final next = inside && ch != ' ' ? paint(r, c, ch) : null;
        if (next != at && (next != null || !inside || ch != ' ')) {
          flush();
          at = next;
        }
        run.write(ch);
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
