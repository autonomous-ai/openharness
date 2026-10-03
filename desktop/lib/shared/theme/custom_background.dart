import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

/// How a custom background is sized to the page.
enum BackgroundFit {
  fill('Fill'),
  fit('Fit'),
  center('Center'),
  tile('Tile');

  const BackgroundFit(this.label);
  final String label;

  static BackgroundFit fromId(Object? id) =>
      values.where((value) => value.name == id).firstOrNull ?? fill;
}

/// The one image the user supplied, and how it is shown.
///
/// [image] names Harness's own copy inside the backgrounds folder, never the
/// file the user picked: that one may move, be unplugged or be deleted. A new
/// name per import also retires the old copy from Flutter's image cache.
@immutable
class CustomBackground {
  const CustomBackground({
    this.image,
    this.dim = dimDefault,
    this.fit = BackgroundFit.fill,
  });

  final String? image;
  final double dim;
  final BackgroundFit fit;

  static const double dimDefault = 0.4;
  static const double dimMax = 0.8;

  CustomBackground copyWith({
    String? image,
    double? dim,
    BackgroundFit? fit,
    bool clearImage = false,
  }) => CustomBackground(
    image: clearImage ? null : (image ?? this.image),
    dim: dim == null ? this.dim : _clampDim(dim),
    fit: fit ?? this.fit,
  );

  Map<String, Object?> toJson() => {
    if (image != null) 'image': image,
    'dim': dim,
    'fit': fit.name,
  };

  /// Tolerant like the rest of the appearance file: anything unreadable lands
  /// on the default rather than throwing.
  factory CustomBackground.fromJson(Object? json) {
    if (json is! Map) return const CustomBackground();
    final image = json['image'];
    final dim = json['dim'];
    return CustomBackground(
      // A bare file name only: a hand-edited path must not point outside the
      // backgrounds folder.
      image: image is String && image.isNotEmpty && p.basename(image) == image
          ? image
          : null,
      dim: dim is num ? _clampDim(dim.toDouble()) : dimDefault,
      fit: BackgroundFit.fromId(json['fit']),
    );
  }

  static double _clampDim(double dim) =>
      dim.isFinite ? dim.clamp(0.0, dimMax) : dimDefault;

  @override
  bool operator ==(Object other) =>
      other is CustomBackground &&
      other.image == image &&
      other.dim == dim &&
      other.fit == fit;

  @override
  int get hashCode => Object.hash(image, dim, fit);
}

/// A file Harness will not use as a background, with a line for the person.
class CustomBackgroundError implements Exception {
  const CustomBackgroundError(this.message);
  final String message;

  @override
  String toString() => message;
}

const customBackgroundExtensions = ['png', 'jpg', 'jpeg', 'webp'];
const customBackgroundMaxBytes = 20 * 1024 * 1024;

/// Longest side kept. Larger images are scaled down on import so memory and
/// first paint stay predictable, whatever a camera produced.
const customBackgroundMaxSide = 3840;

/// Copies [sourcePath] into [directory] and returns the copy's file name.
///
/// The image is decoded here, not just checked by extension, so a broken file
/// is refused now rather than painting Blank later. It is re-encoded as PNG
/// only when it has to change: when it is too large, or animated (a background
/// holds still).
Future<String> importCustomBackground(
  String sourcePath,
  Directory directory,
) async {
  final extension = p.extension(sourcePath).toLowerCase().replaceFirst('.', '');
  if (!customBackgroundExtensions.contains(extension)) {
    throw const CustomBackgroundError('Use a PNG, JPEG or WebP image.');
  }
  final Uint8List bytes;
  try {
    final source = File(sourcePath);
    if (await source.length() > customBackgroundMaxBytes) {
      throw const CustomBackgroundError('Images must be 20 MB or smaller.');
    }
    bytes = await source.readAsBytes();
  } on FileSystemException {
    throw const CustomBackgroundError('Couldn’t read that file.');
  }

  final Uint8List out;
  final String outExtension;
  ui.ImageDescriptor? descriptor;
  ui.Codec? codec;
  ui.Image? frame;
  try {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    descriptor = await ui.ImageDescriptor.encoded(buffer);
    buffer.dispose();
    final width = descriptor.width, height = descriptor.height;
    final longest = math.max(width, height);
    final scale = longest > customBackgroundMaxSide
        ? customBackgroundMaxSide / longest
        : 1.0;
    codec = await descriptor.instantiateCodec(
      targetWidth: math.max(1, (width * scale).round()),
      targetHeight: math.max(1, (height * scale).round()),
    );
    frame = (await codec.getNextFrame()).image;
    if (scale == 1.0 && codec.frameCount == 1) {
      out = bytes;
      outExtension = extension == 'jpeg' ? 'jpg' : extension;
    } else {
      final png = await frame.toByteData(format: ui.ImageByteFormat.png);
      if (png == null) throw const FormatException();
      out = png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes);
      outExtension = 'png';
    }
  } catch (_) {
    throw const CustomBackgroundError('That image couldn’t be opened.');
  } finally {
    frame?.dispose();
    codec?.dispose();
    descriptor?.dispose();
  }

  try {
    await directory.create(recursive: true);
    final name =
        'custom-${DateTime.now().microsecondsSinceEpoch}.$outExtension';
    // Written aside and renamed, so a crash mid-write never leaves a half image
    // under the name the preferences point at.
    final partial = File(p.join(directory.path, '$name.partial'));
    await partial.writeAsBytes(out, flush: true);
    await partial.rename(p.join(directory.path, name));
    return name;
  } on FileSystemException {
    throw const CustomBackgroundError('Couldn’t save a copy of that image.');
  }
}

/// Removes every copy in [directory] except [keep]. Best effort: a file that
/// will not delete costs disk space, not the background.
Future<void> pruneCustomBackgrounds(Directory directory, {String? keep}) async {
  try {
    if (!await directory.exists()) return;
    await for (final entry in directory.list()) {
      if (entry is File && p.basename(entry.path) != keep) {
        try {
          await entry.delete();
        } on FileSystemException {
          // See above.
        }
      }
    }
  } on FileSystemException {
    // See above.
  }
}
