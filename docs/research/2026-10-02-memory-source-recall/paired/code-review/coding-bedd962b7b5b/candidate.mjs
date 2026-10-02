export function navigationState(current, event) {
  if (event === 'expand') return 'expanded';
  if (event === 'collapse') return 'compact';
  return current;
}
