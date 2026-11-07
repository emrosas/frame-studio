import type { Ctx2D, ParamSchema, Rig, SpokenWord } from '../../engine/types';
import { easings } from '../../engine/easing';
import { choice, col, num, readParams, str } from '../parts/params';
import { paintLine } from '../pixel/font';
import { CAPTION_FACE, layoutCaptions, PIXEL_FONT, type CaptionCase, type CaptionLayout, type CaptionOptions, type CaptionPosition, type PlacedWord } from './caption-layout';
import { typefaces } from './faces/index';
import { traceGlyph } from './typeface';

const POP_SECONDS = 0.14;
const POP_SCALE = 1.22;
const isPainted = (c: string) => c !== 'none' && c !== 'transparent' && c !== '';

const params: ParamSchema = {
  cue: str('voice', "The id of a sound cue in this scene with words. align_voice gives a cue its words."),
  style: choice('word-highlight', ['word-highlight', 'pop-in', 'line'], 'word-highlight shows the page and lights the word being said. pop-in shows each word as it is said. line shows the page plain.'),
  font: choice(CAPTION_FACE, [...typefaces.map((f) => f.id), PIXEL_FONT], `The typeface, or "${PIXEL_FONT}" for the bitmap font on a pixel stage.`),
  size: num(0, 0, 400, 'Font size in stage pixels, or stage pixels per font pixel for the pixel font. 0 picks one for the stage.'),
  color: col('#ffffff', 'Text colour.'),
  highlight: col('#ffd23f', 'Colour of the word being said.'),
  stroke: col('#111111', 'Outline colour. "none" skips the outline.'),
  strokeWidth: num(10, 0, 100, 'Outline width in stage pixels. 0 skips it. A typeface only.'),
  position: choice('bottom', ['top', 'middle', 'bottom'], 'Where the block sits in the safe area: inside what TikTok, Reels and Shorts leave clear on a vertical stage, inside a title-safe margin on any other.'),
  offsetX: num(0, -4000, 4000, 'Moves the block across, in stage pixels.'),
  offsetY: num(0, -4000, 4000, 'Moves the block down, in stage pixels.'),
  width: num(0, 0, 8000, 'Line width in stage pixels. 0 is as wide as the safe area allows, centred on the stage.'),
  lines: num(2, 1, 4, 'Most lines on one page.'),
  case: choice('none', ['none', 'upper', 'lower'], 'Draw the words as written, in capitals, or in lower case. The pixel font is always capitals.'),
  opacity: num(1, 0, 1, 'Opacity, 0 to 1.'),
};

/** The last layout, by its words and everything else that shapes it. Layout is pure, so keeping one changes nothing a frame draws. */
const layouts = new WeakMap<readonly SpokenWord[], { key: string; layout: CaptionLayout }>();

function cachedLayout(words: readonly SpokenWord[], options: CaptionOptions, width: number, height: number): CaptionLayout {
  const key = JSON.stringify([options, width, height]);
  const hit = layouts.get(words);
  if (hit?.key === key) return hit.layout;
  const layout = layoutCaptions(words, options, { width, height });
  layouts.set(words, { key, layout });
  return layout;
}

/** The word a page is on at `t`: the one being said, or else the last one said, so the light doesn't flicker off between words. */
function currentWord(words: readonly PlacedWord[], t: number): PlacedWord | null {
  let current: PlacedWord | null = null;
  for (const w of words) if (w.word.start <= t + 1e-9) current = w;
  return current;
}

/** Adds a word's outlines to the current path. */
function traceWord(ctx: Ctx2D, w: PlacedWord, scale: number): void {
  for (const g of w.glyphs) if (g.char !== ' ') traceGlyph(ctx, g.glyph, w.x + g.x, w.baseline, scale);
}

/** Runs `draw` scaled about the word's middle, as it pops in. */
function popped(ctx: Ctx2D, w: PlacedWord, t: number, style: string, draw: () => void): void {
  const age = (t - w.word.start) / POP_SECONDS;
  if (style !== 'pop-in' || age >= 1) {
    draw();
    return;
  }
  const scale = POP_SCALE - (POP_SCALE - 1) * easings.outCubic(Math.max(0, age));
  const cx = w.x + w.width / 2;
  const cy = w.top + w.height / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}

/**
 * Captions that keep time with a spoken cue (ADR 0016). A page of words holds
 * while they're said, broken at sentences, pauses and what fits. Everything comes
 * from kit.speech and t, so a frame is the same however it's reached, and the
 * text is vector outlines or the pixel font, never fillText.
 */
export const captions: Rig = {
  id: 'captions',
  description:
    'Captions from a sound cue\'s words, in time with the voice: word-highlight, pop-in or line. ' +
    'Sits inside the safe area by default. Give it depth 0 so a camera leaves it alone. The cue needs words first: run align_voice.',
  params,
  draw(ctx, values, t, _rng, stage, kit) {
    const p = readParams(params, values);
    const words = kit.speech(p.string('cue'));
    if (words.length === 0) return;
    const style = p.string('style');
    const { pages, scale, pixel, size } = cachedLayout(
      words,
      {
        font: p.string('font'),
        size: p.number('size'),
        lines: p.integer('lines'),
        width: p.number('width'),
        position: p.string('position') as CaptionPosition,
        offsetX: p.number('offsetX'),
        offsetY: p.number('offsetY'),
        letterCase: p.string('case') as CaptionCase,
      },
      stage.width,
      stage.height,
    );
    const page = pages.find((c) => t >= c.start - 1e-9 && t < c.end);
    if (!page) return;
    const shown = style === 'pop-in' ? page.words.filter((w) => w.word.start <= t + 1e-9) : page.words;
    const lit = style === 'line' ? null : currentWord(page.words, t);
    const colourOf = (w: PlacedWord) => (w === lit ? p.string('highlight') : p.string('color'));
    ctx.globalAlpha *= p.number('opacity');

    if (pixel) {
      for (const w of shown) {
        ctx.fillStyle = colourOf(w);
        paintLine((x, y, width, height) => ctx.fillRect(x, y, width, height), w.text, w.x, w.top, size);
      }
      return;
    }
    const stroke = p.string('stroke');
    const strokeWidth = p.number('strokeWidth');
    if (strokeWidth > 0 && isPainted(stroke)) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      for (const w of shown) {
        popped(ctx, w, t, style, () => {
          ctx.beginPath();
          traceWord(ctx, w, scale);
          ctx.stroke();
        });
      }
    }
    for (const w of shown) {
      popped(ctx, w, t, style, () => {
        ctx.beginPath();
        traceWord(ctx, w, scale);
        ctx.fillStyle = colourOf(w);
        ctx.fill();
      });
    }
  },
};
