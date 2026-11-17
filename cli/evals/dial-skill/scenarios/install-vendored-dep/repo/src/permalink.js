import slug from 'tiny-slug'

export function permalink(post) {
  return `/${post.date.slice(0, 4)}/${slug(post.title)}`
}
