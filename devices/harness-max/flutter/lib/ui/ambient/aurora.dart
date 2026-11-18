// Ambient's slow particle drift (the mockup's drawAurora): 150 specks in the lavender, Claude and Codex inks drift on
// a slowly turning flow field and leave short fading trails, as the mockup's canvas does by veiling each frame in 10 %
// black before drawing the specks again.
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// The field's specks and their recent places. Steps at the mockup's 60 frames a second, whatever the glass draws at.
class AuroraField {
  AuroraField(this.size, {int seed = 7, int count = 150}) {
    final r = math.Random(seed);
    for (var i = 0; i < count; i++) {
      _x.add(r.nextDouble() * size.width);
      _y.add(r.nextDouble() * size.height);
      _rgb.add(_inks[r.nextInt(_inks.length)]);
      _alpha.add(0.15 + r.nextDouble() * 0.35);
    }
    final n = count * trail;
    _hx = Float32List(n);
    _hy = Float32List(n);
    for (var i = 0; i < count; i++) {
      for (var k = 0; k < trail; k++) {
        _hx[i * trail + k] = _x[i];
        _hy[i * trail + k] = _y[i];
      }
    }
    _positions = Float32List(n * 8);
    _colors = Int32List(n * 4);
    _indices = Uint16List(n * 6);
    for (var q = 0; q < n; q++) {
      _indices.setAll(q * 6, [q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3]);
    }
  }

  /// The mockup's three inks: --accent, --claude, --codex.
  static const _inks = [0xC6AAEF, 0xFF9E64, 0x8FB4FF];

  /// Places kept per speck: the veil leaves 0.9^k of a place k frames old, 8 % after 24, where the mockup's 8-bit
  /// canvas has rounded a trail's tail away (its dashes measure as long as these).
  static const int trail = 24;
  static const double frameMs = 1000 / 60;
  static final List<double> _veil = [for (var k = 0; k < trail; k++) math.pow(0.9, k).toDouble()];

  final Size size;
  final List<double> _x = [], _y = [], _alpha = [];
  final List<int> _rgb = [];
  late final Float32List _hx, _hy;
  late final Float32List _positions;
  late final Int32List _colors;
  late final Uint16List _indices;

  /// The 60 Hz frames the clock has passed, the ones the specks moved on (fewer after a stall), and the newest place's
  /// slot in each speck's ring of places.
  int frames = 0, moves = 0;
  int _head = 0;

  int get count => _x.length;

  /// One of the mockup's frames, at its clock [ms].
  void step(double ms) {
    final w = size.width, h = size.height, k = ms / 6000;
    _head = (_head + 1) % trail;
    for (var i = 0; i < count; i++) {
      var x = _x[i], y = _y[i];
      final ang = math.sin(x * 0.003 + k) * 1.2 + math.cos(y * 0.012 - k * 1.3);
      x += math.cos(ang) * 0.45 + 0.12;
      y += math.sin(ang) * 0.3;
      if (x > w) x = 0;
      if (x < 0) x = w;
      if (y > h) y = 0;
      if (y < 0) y = h;
      _x[i] = x;
      _y[i] = y;
      _hx[i * trail + _head] = x;
      _hy[i * trail + _head] = y;
    }
    frames++;
    moves++;
  }

  /// Steps up to [ms] on the 60 Hz clock, at most [catchUp] frames at once (a stalled glass slows the drift rather
  /// than jumping it).
  void runTo(double ms, {int catchUp = 4}) {
    var due = (ms / frameMs).floor() - frames;
    if (due > catchUp) {
      frames += due - catchUp;
      due = catchUp;
    }
    for (var i = 0; i < due; i++) {
      step((frames + 1) * frameMs);
    }
  }

  /// Every speck's places as 2 px squares, oldest first so the newer lie on top, each veiled by its age; one draw.
  ui.Vertices vertices() {
    var q = 0;
    for (var i = 0; i < count; i++) {
      final rgb = _rgb[i], a = _alpha[i];
      for (var age = trail - 1; age >= 0; age--) {
        final slot = i * trail + (_head - age + trail) % trail;
        final alpha = (a * _veil[age] * 255).round();
        final x = _hx[slot], y = _hy[slot], p = q * 8;
        _positions
          ..[p] = x
          ..[p + 1] = y
          ..[p + 2] = x + 2
          ..[p + 3] = y
          ..[p + 4] = x + 2
          ..[p + 5] = y + 2
          ..[p + 6] = x
          ..[p + 7] = y + 2;
        final argb = (alpha << 24) | rgb;
        _colors
          ..[q * 4] = argb
          ..[q * 4 + 1] = argb
          ..[q * 4 + 2] = argb
          ..[q * 4 + 3] = argb;
        q++;
      }
    }
    return ui.Vertices.raw(ui.VertexMode.triangles, _positions, colors: _colors, indices: _indices);
  }
}

class AuroraPainter extends CustomPainter {
  AuroraPainter(this.field, this.clock) : super(repaint: clock);
  final AuroraField field;

  /// The field's clock in ms: each tick steps the field and paints it.
  final ValueListenable<double> clock;

  @override
  void paint(Canvas canvas, Size size) {
    field.runTo(clock.value);
    final v = field.vertices();
    // The squares' own colours, as they are: BlendMode.dst keeps the vertex colours over the paint's.
    canvas.drawVertices(v, BlendMode.dst, Paint());
    v.dispose();
  }

  @override
  bool shouldRepaint(AuroraPainter old) => old.field != field || old.clock != clock;
}
