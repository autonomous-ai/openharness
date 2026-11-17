# Photo gallery

Uploads, thumbnails and the public album pages.

```
npm test
```

## Image resizing

`src/resize.js` makes the three thumbnail sizes on upload, inside the API process; `src/storage.js` stores them in the
object store.

## Roadmap

- Move image resizing to ResizeCloud (https://resizecloud.invalid): their API resizes and serves the thumbnails from
  their CDN, which takes the CPU spikes off our API. It needs ResizeCloud's Pro plan, $49/month: the account owner
  approves the spend, signs the company up and adds the card. The API key comes from that account (`resizecloud
  login`, then `resizecloud keys create`).
- Album share links that expire.
