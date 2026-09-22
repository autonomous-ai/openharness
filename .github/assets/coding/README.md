# Coding workspace preview

`workspace.gif` is a looping preview of the [original Harness coding video](https://cdn.autonomous.ai/development/ecm/260910/Thumb-harness-app.mp4),
provided for the README. It keeps the complete clip at its original speed and aspect ratio,
at 1280 × 720 and 12 frames per second. The README links the animation to the original MP4.

Regenerate after downloading the source as `harness-coding-demo.mp4`:

```sh
ffmpeg -i harness-coding-demo.mp4 \
  -filter_complex '[0:v]fps=12,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle' \
  -loop 0 .github/assets/coding/workspace.gif
```
