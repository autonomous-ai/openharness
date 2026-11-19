export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length
}
