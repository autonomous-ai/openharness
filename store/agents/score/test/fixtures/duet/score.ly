\version "2.24.3"
% Concert-pitch variables only. ensemble.json owns the player brief and timing.
fluteMusic = \relative c'' {
  c2\p( d4 e) | e2( d4) r4 |
  d2( e4 f) | f2( e4) r4 \breathe \break |
  e4\mp( f g2) | f2( e4 d) |
  d2( e4 d) | c1\pp \bar "|."
}
pianoRight = \relative c' {
  <c e g>2\p <c e g> | <c e a>2 <c e a> |
  <d f a>2 <d f a> | <c f a>2 <c e g> |
  <c e g>2\mp <d g b> | <c f a>2 <c e a> |
  <d g b>2 <d g b> | <c e g>1\pp
}
pianoLeft = \relative c {
  c1\p | a1 | d1 | f2 c |
  c1\mp | f1 | g,1 | c1\pp
}
