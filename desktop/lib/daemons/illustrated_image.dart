import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:flutter/services.dart';

import 'illustrated_styles.g.dart';

/// Styled images use Flutter's bounded image cache, including in-flight decode
/// deduplication and eviction. No timer or unbounded per-individual bitmap map.
class IllustratedImage extends ImageProvider<IllustratedImage> {
  const IllustratedImage(this.asset, this.colour, this.mark);
  final String asset;
  final int colour, mark;

  @override
  Future<IllustratedImage> obtainKey(ImageConfiguration configuration) =>
      SynchronousFuture(this);

  @override
  ImageStreamCompleter loadImage(
    IllustratedImage key,
    ImageDecoderCallback decode,
  ) => OneFrameImageStreamCompleter(
    _load().then((image) => ImageInfo(image: image, scale: 1)),
  );

  Future<ui.Image> _read(String path) async {
    final bytes = await rootBundle.load(path);
    final codec = await ui.instantiateImageCodec(
      bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
    );
    try {
      return (await codec.getNextFrame()).image;
    } finally {
      codec.dispose();
    }
  }

  Future<ui.Image> _load() async {
    final images = <ui.Image>[];
    try {
      final base = await _read(asset);
      images.add(base);
      final material = await _read(asset.replaceFirst('.png', '_material.png'));
      images.add(material);
      final marks = await _read(asset.replaceFirst('.png', '_marks.png'));
      images.add(marks);
      if (images.any((i) => i.width != base.width || i.height != base.height)) {
        throw StateError('Companion material dimensions differ');
      }
      final data = await Future.wait(
        images.map(
          (i) => i.toByteData(format: ui.ImageByteFormat.rawStraightRgba),
        ),
      );
      final pixels = Uint8List.fromList(data[0]!.buffer.asUint8List());
      final materialBytes = data[1]!.buffer.asUint8List();
      final markBytes = data[2]!.buffer.asUint8List();
      final species = asset.split('/').last.split('_').first;
      final palettes = illustratedStyles[species]!['palettes'] as List;
      final palette = colour >= 0 && colour < palettes.length
          ? palettes[colour] as List
          : null;
      shadeCompanionPixels(pixels, materialBytes, markBytes, palette, mark);
      final buffer = await ui.ImmutableBuffer.fromUint8List(pixels);
      final descriptor = ui.ImageDescriptor.raw(
        buffer,
        width: base.width,
        height: base.height,
        pixelFormat: ui.PixelFormat.rgba8888,
      );
      final codec = await descriptor.instantiateCodec();
      try {
        return (await codec.getNextFrame()).image;
      } finally {
        codec.dispose();
        descriptor.dispose();
        buffer.dispose();
      }
    } finally {
      for (final image in images) {
        image.dispose();
      }
    }
  }

  @override
  bool operator ==(Object other) =>
      other is IllustratedImage &&
      asset == other.asset &&
      colour == other.colour &&
      mark == other.mark;
  @override
  int get hashCode => Object.hash(asset, colour, mark);
}

/// The integer shader shared with the firmware and AppKit. The returned pixels
/// are premultiplied RGBA, ready for ImageDescriptor.raw.
void shadeCompanionPixels(
  Uint8List pixels,
  Uint8List material,
  Uint8List marks,
  List? palette,
  int mark,
) {
  for (var at = 0; at < pixels.length; at += 4) {
    final alpha = pixels[at + 3];
    final shade = material[at], weight = material[at + 1];
    final marking = mark == 1
        ? material[at + 2]
        : mark >= 2 && mark <= 4
        ? marks[at + mark - 2]
        : 0;
    for (var channel = 0; channel < 3; channel++) {
      var value = pixels[at + channel];
      if (palette != null) {
        final dark = (palette[0] as List)[channel] as int,
            light = (palette[1] as List)[channel] as int;
        value =
            ((value * (255 - weight) +
                        dark * weight +
                        (light - dark) * shade +
                        127) ~/
                    255)
                .clamp(0, 255);
      }
      value = value * (255 - marking * 100 ~/ 255) ~/ 255;
      pixels[at + channel] = (value * alpha + 127) ~/ 255;
    }
  }
}
