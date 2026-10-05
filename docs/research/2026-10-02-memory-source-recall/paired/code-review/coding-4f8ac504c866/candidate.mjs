export function focusAfter(current, event) {
  if (event === 'search_completed') {
    return 'search';
  }
  return current;
}
