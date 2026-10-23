import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';

/// Stable across engine/model changes and shared by the roster and messages.
class SuperTabAvatar extends StatelessWidget {
  const SuperTabAvatar({
    super.key,
    required this.identity,
    required this.name,
    this.size = 30,
  });
  final String identity, name;
  final double size;

  @override
  Widget build(BuildContext context) {
    var hash = 0;
    for (final rune in identity.runes) {
      hash = (hash * 31 + rune) & 0x7fffffff;
    }
    hash = ((hash ^ (hash >> 16)) * 0x45d9f3b) & 0x7fffffff;
    final color = HSLColor.fromAHSL(
      1,
      (hash % 360).toDouble(),
      .42,
      Theme.of(context).brightness == Brightness.dark ? .72 : .36,
    ).toColor();
    final words = name
        .trim()
        .split(RegExp(r'[\s@._-]+'))
        .where((w) => w.isNotEmpty)
        .toList();
    final initial = words.isEmpty
        ? '?'
        : words.first.characters.first.toUpperCase();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color.withValues(alpha: .14),
        shape: BoxShape.circle,
      ),
      child: Text(
        initial,
        textScaler: TextScaler.noScaling,
        style: DesktopChrome.control(
          medium: true,
          color: color,
        ).copyWith(fontSize: size * .43),
      ),
    );
  }
}

String superTabPersonName(String email) => email.split('@').first;

/// A computer as it calls itself: a Bonjour hostname without its `.local` suffix ("MacBookPro2021"), never mapped
/// to a model name, so two machines of one model stay told apart. A name a person chose stays as it is.
String superTabMachineName(String name) {
  const suffix = '.local';
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}
