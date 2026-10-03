/// Whether a paste that holds both [text] and a picture is a paste of the
/// text. It is — a document's copy carries a picture of itself beside its
/// words, a copied file its icon beside its name — unless the text is only a
/// web address: Safari's Copy Image puts the picture's own URL next to it, and
/// the picture is what was copied.
bool pastedTextWins(String? text) {
  final trimmed = text?.trim() ?? '';
  return trimmed.isNotEmpty && !_webAddress.hasMatch(trimmed);
}

final _webAddress = RegExp(r'^https?://\S+$');
