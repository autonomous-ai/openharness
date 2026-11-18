// Attention: the agent that needs the person, its question and answers, or its finished or failed turn (the mockup's
// renderAt). The pet on the left; "name [app] asks" (or "wants to run", "is done", "failed", or where an answer
// stands); the question, the command in mono, or the turn's words. When the bar takes its answers, the options and
// Say it, or Allow and Deny; when it does not, where to answer it. A tap anywhere else brings the agent up on the
// computer.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../app_icon.dart';
import '../attention/answer_button.dart';
import '../attention/kind.dart';
import '../attention/pet_fit.dart';
import '../pet.dart' hide petFit;
import '../tokens.dart';

class AttentionPage extends StatefulWidget {
  const AttentionPage({super.key, required this.model});
  final BarModel model;

  @override
  State<AttentionPage> createState() => _AttentionPageState();
}

/// A button on the card: its words, its look, and what a tap does (null: nothing can be pressed now).
class _Answer {
  const _Answer(this.label, this.look, this.onTap, {this.mic = false});
  final String label;
  final AnswerLook look;
  final VoidCallback? onTap;
  final bool mic;
}

/// How far past its edges a button takes a finger: half the gap to its neighbour across, most of the space above. The
/// bar's touch lands off the finger, and a miss here is not harmless: it brings the agent up on the computer.
const double _slopX = 7, _slopY = 18;

class _AttentionPageState extends State<AttentionPage> {
  final List<GlobalKey> _keys = [];
  List<_Answer> _answers = const [];
  int? _held;

  BarModel get model => widget.model;

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: model, builder: (context, _) => _page());

  // ---- taps: one detector for the page, so a button can take a finger that lands just off it ----

  int? _answerAt(Offset global) {
    int? best;
    var bestGap = double.infinity;
    for (var i = 0; i < _answers.length && i < _keys.length; i++) {
      final box = _keys[i].currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize) continue;
      final at = box.globalToLocal(global);
      final edge = Offset.zero & box.size;
      if (!Rect.fromLTRB(-_slopX, -_slopY, edge.right + _slopX, edge.bottom + _slopY).contains(at)) continue;
      // Rows of buttons share the space between them: the nearer button takes the finger.
      final dx = at.dx < 0 ? -at.dx : (at.dx > edge.right ? at.dx - edge.right : 0.0);
      final dy = at.dy < 0 ? -at.dy : (at.dy > edge.bottom ? at.dy - edge.bottom : 0.0);
      final gap = dx * dx + dy * dy;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return best;
  }

  void _down(TapDownDetails d) {
    final i = _answerAt(d.globalPosition);
    if (i != null && _answers[i].onTap != null) setState(() => _held = i);
  }

  void _up(TapUpDetails d) {
    final i = _answerAt(d.globalPosition);
    if (_held != null) setState(() => _held = null);
    if (i == null) {
      model.away();
      return;
    }
    // A button that cannot be pressed now (the answer is being read or sent) swallows the tap.
    _answers[i].onTap?.call();
  }

  void _cancel() {
    if (_held != null) setState(() => _held = null);
  }

  // ---- the page ----

  Widget _page() {
    final attn = model.attention;
    final agent = model.agentById(attn?.agentId);
    if (attn == null || agent == null) {
      _answers = const [];
      return const SizedBox.expand();
    }
    final kind = attn.kind;
    final ask = kind == AttnKind.ask ? model.askOf(agent.id) : null;
    final answers = ask != null && model.takesAnswers(agent);
    final permission = ask?.permission ?? false;
    final items = ask?.items ?? const <AskItem>[];
    final item = items.isEmpty ? null : items[ask!.step.clamp(0, items.length - 1)];

    _answers = answers && ask.phase != AskPhase.failed ? _answersFor(agent, ask, item) : const [];
    while (_keys.length < _answers.length) {
      _keys.add(GlobalKey());
    }
    if (_held != null && _held! >= _answers.length) _held = null;

    // Beside the buttons, or alone where they would be: why the answer failed, or the daemon's receipt.
    String note = '';
    var noteInk = Ink.rest;
    if (answers && ask.phase == AskPhase.failed) {
      note = ask.note.isNotEmpty ? ask.note : 'Not sent';
      noteInk = Ink.failText;
    } else if (answers && ask.phase == AskPhase.sent) {
      note = ask.note;
    }
    String hint = '';
    if (ask != null && !answers) {
      final app = ask.app.isNotEmpty ? ask.app : model.appOf(agent);
      hint = app.isEmpty ? 'Answer it on the computer' : 'Answer it in $app';
    }

    final engine = petEngineOf(agent.engine);
    final scene = smallPetScene(agent.engine, kind);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: _down,
      onTapUp: _up,
      onTapCancel: _cancel,
      child: Row(children: [
        SizedBox(
          width: 300,
          child: Center(
            child: RepaintBoundary(
                child: PetView(engine: engine, scene: scene, size: petFit(engine, scene, const Size(240, 230)))),
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(right: 60),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _who(agent, kind, ask, permission, items.length),
                ..._words(agent, kind, ask, item, answers, permission),
                if (_answers.isNotEmpty || note.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  _buttons(note, noteInk),
                ],
                if (hint.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  Text(hint, style: Face.s(19, color: Ink.rest), maxLines: 1, overflow: TextOverflow.ellipsis),
                ],
              ],
            ),
          ),
        ),
      ]),
    );
  }

  /// "harness-cli [H] asks": the name in the kind's colour, the app's icon, the verb or where the answer stands.
  Widget _who(Agent agent, AttnKind kind, Ask? ask, bool permission, int steps) {
    final verb = kind != AttnKind.ask
        ? kindWord(kind)
        : switch (ask?.phase) {
            AskPhase.sending => 'Sending…',
            AskPhase.sent => 'Sent',
            _ => permission ? 'wants to run' : kindWord(kind),
          };
    final app = agent.host.isNotEmpty ? agent.host : model.shownApp;
    // The mockup's row stretches its items to the icon's 28 px and leaves each word at the top of it.
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Flexible(
        child: Text(agent.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Face.s(20, weight: FontWeight.w600, color: kindInk(kind))),
      ),
      if (hasAppIcon(app)) ...[const SizedBox(width: 12), AppIcon(app, size: 28)],
      const SizedBox(width: 12),
      Text(verb, style: Face.s(20, color: Ink.dim)),
      if (steps > 1) ...[
        const SizedBox(width: 12),
        Text('${ask!.step + 1} / $steps', style: Face.s(20, color: Ink.faint)),
      ],
    ]);
  }

  /// The question (two rows over buttons, else three), a permission's command in mono, or the turn's words.
  List<Widget> _words(Agent agent, AttnKind kind, Ask? ask, AskItem? item, bool answers, bool permission) {
    if (permission) {
      return [
        const SizedBox(height: 10),
        Text(_command(ask!),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
                fontFamily: Face.mono,
                fontSize: 32,
                fontWeight: FontWeight.w500,
                height: 1.3,
                leadingDistribution: TextLeadingDistribution.even,
                color: Color(0xFFF3EBFF))),
      ];
    }
    final String words;
    if (kind != AttnKind.ask) {
      words = agent.said;
    } else if (ask == null) {
      words = agent.said;
    } else if (ask.items.length > 1 && item != null) {
      words = item.q;
    } else {
      words = ask.text.isNotEmpty ? ask.text : (item?.q ?? agent.said);
    }
    if (words.isEmpty) return const [];
    final recap = kind != AttnKind.ask;
    return [
      const SizedBox(height: 12),
      ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1040),
        child: Text(words,
            maxLines: answers ? 2 : 3,
            overflow: TextOverflow.ellipsis,
            style: Face.s(answers ? 34 : 38,
                    weight: recap ? FontWeight.w400 : FontWeight.w500,
                    color: recap ? Ink.recap : Ink.fg,
                    height: 1.3)
                .copyWith(leadingDistribution: TextLeadingDistribution.even)),
      ),
    ];
  }

  Widget _buttons(String note, Color noteInk) => Wrap(
        spacing: 14,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (var i = 0; i < _answers.length; i++)
            KeyedSubtree(
              key: _keys[i],
              child: AnswerButton(
                  label: _answers[i].label, look: _answers[i].look, mic: _answers[i].mic, held: _held == i),
            ),
          if (note.isNotEmpty)
            Padding(
              padding: EdgeInsets.only(left: _answers.isEmpty ? 0 : 10),
              child: Text(note, style: Face.s(19, color: noteInk), maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
        ],
      );

  /// The options of the question on the card (a permission prompt's Allow and Deny), then Say it. While the answer is
  /// read or goes, what was chosen stays lit and nothing can be pressed.
  List<_Answer> _answersFor(Agent agent, Ask ask, AskItem? item) {
    final ready = ask.phase == AskPhase.ready;
    final mask = ask.step < ask.choices.length ? ask.choices[ask.step] : 0;
    final options = item?.options ?? const <String>[];
    bool chosen(int i) => i >= 0 && (mask >> i) & 1 == 1;
    AnswerLook look(AnswerLook live, int option) => ready ? live : (chosen(option) ? AnswerLook.chosen : AnswerLook.off);
    if (ask.permission) {
      final yes = options.indexWhere((o) => _approves.hasMatch(o));
      final no = options.indexWhere((o) => _rejects.hasMatch(o));
      return [
        _Answer('Allow', look(AnswerLook.allow, yes), ready ? model.allow : null),
        _Answer('Deny', look(AnswerLook.deny, no), ready ? model.deny : null),
      ];
    }
    return [
      for (var i = 0; i < options.length; i++)
        _Answer(options[i], look(AnswerLook.plain, i), ready ? () => model.choose(i) : null),
      if (model.takesVoice(agent))
        _Answer('Say it', ready ? AnswerLook.plain : AnswerLook.off, ready ? model.sayIt : null, mic: true),
    ];
  }
}

final _approves = RegExp(r'^\s*(yes|allow|approve)', caseSensitive: false);
final _rejects = RegExp(r'^\s*(no\b|deny|reject)', caseSensitive: false);

/// A permission prompt's command: the daemon's own when it sent one, else the words after the prompt's first ": "
/// ("Approve Bash command: make flash").
String _command(Ask ask) {
  if (ask.command.isNotEmpty) return ask.command;
  final at = ask.text.indexOf(': ');
  return at >= 0 && at + 2 < ask.text.length ? ask.text.substring(at + 2) : ask.text;
}
