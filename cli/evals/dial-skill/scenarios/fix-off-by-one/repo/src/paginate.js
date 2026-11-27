export function paginate(items, page, perPage) {
  const start = page * perPage
  return {
    items: items.slice(start, start + perPage),
    page,
    totalPages: Math.ceil(items.length / perPage),
  }
}
