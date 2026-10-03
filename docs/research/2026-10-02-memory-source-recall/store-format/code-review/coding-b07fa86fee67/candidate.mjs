export function treeState(current, event) {
  if (event === 'start_session') {
    return 'condensed';
  }
  if (event === 'expand') {
    return 'expanded';
  }
  if (event === 'collapse') {
    return 'condensed';
  }
  return current;
}
