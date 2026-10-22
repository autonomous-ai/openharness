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
        style: DesktopChrome.control(
          medium: true,
          color: color,
        ).copyWith(fontSize: size * .43),
      ),
    );
  }
}

String superTabPersonName(String email) => email.split('@').first;

/// A Bonjour hostname is useful in details, but noisy in a member list.
/// Only normalize generated hostnames; names chosen by a person stay intact.
String superTabMachineName(String name) {
  if (!name.toLowerCase().endsWith('.local')) return name;
  final host = name.substring(0, name.length - '.local'.length);
  for (final model in const [
    ('mac-?book-?pro', 'MacBook Pro'),
    ('mac-?book-?air', 'MacBook Air'),
    ('mac-?book', 'MacBook'),
    ('mac-?mini', 'Mac mini'),
    ('mac-?studio', 'Mac Studio'),
    ('mac-?pro', 'Mac Pro'),
    ('i-?mac-?pro', 'iMac Pro'),
    ('i-?mac', 'iMac'),
  ]) {
    if (RegExp(
      '(?:^|-)${model.$1}(?:-?[0-9]+(?:,[0-9]+)?)?\$',
      caseSensitive: false,
    ).hasMatch(host)) {
      return model.$2;
    }
  }
  return host;
}
