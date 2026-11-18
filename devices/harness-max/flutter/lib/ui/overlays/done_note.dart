// A finished turn's small note at the glass's bottom right: the agent's pet, "name is done · what it said" on one line
// with the name in the done green, on a card in the toast's colours, low enough to leave the cells' status words clear. A finished turn never takes the glass (the
// owner's call, 18 Nov): its notice waits in Inbox, and a tap on the note reads the agent's page. It slides in from
// the right as it fades in, over the toast's 0.3 s ease, and leaves the same way.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../attention/kind.dart';
import '../pet.dart';
import '../tokens.dart';

class DoneNote extends StatefulWidget {
  const DoneNote({super.key, required this.model});
  final BarModel model;

  @override
  State<DoneNote> createState() => _DoneNoteState();
}

class _DoneNoteState extends State<DoneNote> with SingleTickerProviderStateMixin {
  late final AnimationController _shown = AnimationController(vsync: this, duration: const Duration(milliseconds: 300));
  late final Animation<double> _eased =
      CurvedAnimation(parent: _shown, curve: Curves.ease, reverseCurve: Curves.ease.flipped);

  /// What the card says: kept while it slides away after the model drops the note (its agent may be gone by then).
  String _name = '', _engine = 'claude', _said = '';

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_changed);
    _sync();
  }

  @override
  void didUpdateWidget(DoneNote old) {
    super.didUpdateWidget(old);
    if (old.model != widget.model) {
      old.model.removeListener(_changed);
      widget.model.addListener(_changed);
      _sync();
    }
  }

  @override
  void dispose() {
    widget.model.removeListener(_changed);
    _shown.dispose();
    super.dispose();
  }

  /// True when the words on the card changed.
  bool _sync() {
    final note = widget.model.doneNote;
    if (note == null) {
      _shown.reverse();
      return false;
    }
    final a = widget.model.agentById(note.agentId);
    final was = (_name, _engine, _said);
    _name = a?.name ?? _name;
    _engine = a?.engine ?? _engine;
    _said = note.text;
    _shown.forward();
    return was != (_name, _engine, _said);
  }

  void _changed() {
    if (_sync()) setState(() {});
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        Positioned(
          right: 16 - _reach,
          bottom: 10 - _reach,
          child: AnimatedBuilder(
            animation: _eased,
            builder: (context, child) => IgnorePointer(
              ignoring: widget.model.doneNote == null || _eased.value == 0,
              child: Transform.translate(
                offset: Offset(24 * (1 - _eased.value), 0),
                child: Opacity(opacity: _eased.value, child: child),
              ),
            ),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.model.tapDoneNote,
              child: Padding(
                padding: const EdgeInsets.all(_reach),
                child: RepaintBoundary(child: _Card(name: _name, engine: _engine, said: _said)),
              ),
            ),
          ),
        ),
      ]);
}

/// The finger's target reaches this far past the card all round (the bar's touch lands off the finger at the right).
const double _reach = 12;

class _Card extends StatelessWidget {
  const _Card({required this.name, required this.engine, required this.said});
  final String name, engine, said;

  @override
  Widget build(BuildContext context) => Container(
        key: const ValueKey('done-note'),
        constraints: const BoxConstraints(maxWidth: 460),
        padding: const EdgeInsets.fromLTRB(10, 6, 18, 6),
        decoration: BoxDecoration(
          color: Ink.card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Ink.rim),
          boxShadow: const [
            BoxShadow(color: Color(0x99000000), blurRadius: 24, offset: Offset(0, 8)),
            // The done green, faint, as the cells glow in their state's colour.
            BoxShadow(color: Color(0x220DBC79), blurRadius: 18),
          ],
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          SizedBox(
            width: 34,
            height: 30,
            child: PetView(
                engine: petEngineOf(engine),
                scene: smallPetScene(engine, AttnKind.done),
                size: const Size(34, 30)),
          ),
          const SizedBox(width: 10),
          Text(name, maxLines: 1, style: Face.s(16, weight: FontWeight.w600, color: Ink.done)),
          Text(' is done', style: Face.s(16, weight: FontWeight.w500, color: Ink.dim)),
          if (said.isNotEmpty) ...[
            Text(' · ', style: Face.s(16, color: Ink.faint)),
            Flexible(
              child: Text(said, maxLines: 1, overflow: TextOverflow.ellipsis, style: Face.s(15, color: Ink.recap)),
            ),
          ],
        ]),
      );
}
