/** Application extension; the byte-identical E2EE cryptographic core remains unchanged. */
export const SHARE_REQUEST_TYPES = new Set(['harness_share_list', 'harness_share_invite', 'harness_share_remove',
  'harness_share_link', 'harness_share_comments', 'harness_share_comment_post', 'harness_share_comment_remove'])
export const SHARE_RESULT_TYPES = new Set([...SHARE_REQUEST_TYPES].map(type => `${type}_result`))
