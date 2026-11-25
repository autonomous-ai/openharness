/**
 * A recording the dial's voice gate hears, as a test's dial sends it: 400 ms of 16 kHz 16-bit PCM whose every sample is
 * `fill` in both bytes (7: 1799), so each 10 ms block's mean is over the gate's 600 for more than its 320 ms
 * (voiceLevel.ts). The host transcribes no recording under a second the gate did not hear, so a shorter or quieter
 * clip is answered "Didn't catch that" whatever a fake transcriber says. `fill` from 3 to 252 is heard; a constant clip
 * goes up as it came (voiceGain.ts). In two frames: a cable frame holds at most 8 KB. New buffers each call, so no test
 * changes another's audio.
 */
export const heardClip = (fill = 7): Buffer[] => [Buffer.alloc(6_400, fill), Buffer.alloc(6_400, fill)]
