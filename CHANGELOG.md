# Changelog

## 1.0.0 (2026-11-02)

- First release. `Crumple.create()` hides an element and crumples a WebGL copy of it into a
  paper ball under the pointer: sharp folds computed per pixel, the sheet closing unevenly,
  text still readable on the ball.
- The throw: a flick becomes a lob into a room seen in perspective, the ball shrinks as it flies,
  hits the rim, rolls on the floor, and can be picked up again. Optional aim assist.
- Three bins: frosted glass (default, what is inside shows blurred through the wall),
  white steel and black steel. A frosted stage fades in behind the bin.
- Synthesized sound (crumple, whoosh, rim, landing), no audio file.
- Keyboard path (`throwInto`, a perfect shot), reduced motion and no-WebGL fallbacks (a fade).
- `discard()` for a quiet undo, `restore()` if you want the ball to fly back and unfold.
