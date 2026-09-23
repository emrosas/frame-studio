/**
 * Scene-level hit tests on scenes/bear-test.json against a real raster.
 * @napi-rs/canvas (Skia) is a dev dependency used only by tests.
 *
 * Ground truth comes from full-size renders of each layer alone (and of each
 * part alone, through onlyParts). Only "clean" pixels are checked: alpha 0 or
 * 255 in every layer and the same owner in all 8 neighbours. Antialiased edge
 * pixels are ambiguous by design (see the research note on the probe).
 *
 * Each hitTest call runs the bear's draw code once or twice, a few ms each, so
 * pixels are sampled sparsely.
 */
import { createCanvas } from '@napi-rs/canvas';
import { beforeAll, describe, expect, it } from 'vitest';
import { drawLayer, hitTest, onlyParts, resolveLayer, sceneLayers, validateScene, type Ctx2D, type DrawKit, type Layer, type Scene } from '../src/engine';
import { createDefaultRegistry } from '../src/rigs';
import bearTestJson from '../scenes/bear-test.json?raw';

const registry = createDefaultRegistry();
const FRAMES = [0, 3, 12, 30, 50, 60, 85] as const;
/** Grid step for candidate pixels, and how many to probe per owner per frame. */
const STEP = 7;
const PER_OWNER = 8;
/** Frames where bruno has walked far enough in to own clean pixels. */
const BRUNO_ON_STAGE = new Set([12, 30, 50, 60, 85]);

let scene: Scene;
let W: number;
let H: number;
let probe: Ctx2D;

beforeAll(() => {
  const result = validateScene(JSON.parse(bearTestJson), registry);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  scene = result.scene;
  [W, H] = scene.size;
  probe = createCanvas(1, 1).getContext('2d') as unknown as Ctx2D;
});

/** Alpha channel (0..255) of one layer drawn alone at full size. */
function layerAlpha(layer: Layer, frame: number, kit?: DrawKit): Uint8Array {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d') as unknown as Ctx2D;
  drawLayer(ctx, scene, layer, frame, registry, kit);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  return alpha;
}

const layerById = (id: string) => {
  const layer = sceneLayers(scene).find((l) => l.id === id);
  if (!layer) throw new Error(`no layer ${id}`);
  return layer;
};

/**
 * Owner map from per-layer alphas given top first: the id of the topmost fully
 * opaque layer, null where nothing paints, and undefined where any layer is
 * partly transparent (not clean).
 */
function owners(stack: { id: string; alpha: Uint8Array }[]): (string | null | undefined)[] {
  const out = new Array<string | null | undefined>(W * H);
  for (let i = 0; i < W * H; i++) {
    let owner: string | null | undefined = null;
    for (const { id, alpha } of stack) {
      const a = alpha[i];
      if (a !== 0 && a !== 255) {
        owner = undefined;
        break;
      }
      if (a === 255 && owner === null) owner = id;
    }
    out[i] = owner;
  }
  return out;
}

/** Clean pixels on a sparse grid, grouped by owner, thinned to at most `perOwner` each. */
function cleanSamples(map: (string | null | undefined)[], perOwner: number): Map<string, [number, number][]> {
  const byOwner = new Map<string, [number, number][]>();
  for (let y = 1; y < H - 1; y += STEP) {
    for (let x = 1; x < W - 1; x += STEP) {
      const owner = map[y * W + x];
      if (typeof owner !== 'string') continue;
      let clean = true;
      for (let dy = -1; dy <= 1 && clean; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (map[(y + dy) * W + x + dx] !== owner) {
            clean = false;
            break;
          }
        }
      }
      if (!clean) continue;
      const list = byOwner.get(owner) ?? [];
      list.push([x, y]);
      byOwner.set(owner, list);
    }
  }
  for (const [owner, list] of byOwner) {
    const stride = Math.max(1, Math.floor(list.length / perOwner));
    byOwner.set(
      owner,
      list.filter((_, i) => i % stride === 0).slice(0, perOwner),
    );
  }
  return byOwner;
}

describe('hitTest on scenes/bear-test.json', () => {
  describe('probe parity with full-size renders', () => {
    it.each(FRAMES)('frame %i: clean pixels of every layer return their owner', (frame) => {
      const stack = sceneLayers(scene)
        .slice()
        .reverse()
        .map((layer) => ({ id: layer.id, alpha: layerAlpha(layer, frame) }));
      const samples = cleanSamples(owners(stack), PER_OWNER);
      expect([...samples.keys()].sort(), `owners with clean pixels on frame ${frame}`).toEqual(
        expect.arrayContaining(BRUNO_ON_STAGE.has(frame) ? ['background', 'bruno', 'pip'] : ['background', 'pip']),
      );
      const mismatches: string[] = [];
      let checked = 0;
      for (const [owner, points] of samples) {
        for (const [x, y] of points) {
          checked++;
          const hit = hitTest(probe, scene, frame, x + 0.5, y + 0.5, registry);
          if (hit.layerId !== owner) mismatches.push(`(${x}, ${y}) expected ${owner}, got ${hit.layerId}`);
        }
      }
      expect(checked).toBeGreaterThanOrEqual(16);
      expect(mismatches).toEqual([]);
    });
  });

  describe('named points', () => {
    // Chosen from the renders: bruno's chest is left of pip, pip's belly right
    // of bruno, and the paper corners are clear on every frame.
    const cases: [string, number, number, number, string | null][] = [
      ['bruno body, frame 0', 0, 60, 800, 'bruno'],
      ['bruno body', 30, 760, 900, 'bruno'],
      ['bruno body, override', 60, 760, 900, 'bruno'],
      ['bruno body, mid-motion', 12, 600, 950, 'bruno'],
      ['pip body', 30, 1300, 950, 'pip'],
      ['pip body, inside bruno\'s override', 60, 1300, 950, 'pip'],
      ['paper', 30, 60, 60, 'background'],
      ['paper, frame 0', 0, 1860, 60, 'background'],
      ['outside the stage, left', 30, -5, 500, null],
      ['outside the stage, right edge', 30, 1920, 500, null],
      ['outside the stage, below', 85, 500, 1080, null],
    ];
    it.each(cases)('%s (frame %i, %i, %i) -> %s', (_name, frame, x, y, expected) => {
      expect(hitTest(probe, scene, frame, x, y, registry).layerId).toBe(expected);
    });
  });

  describe('parts', () => {
    /**
     * Bruno's parts in draw order. body is drawn twice with ears between, so
     * a body pixel must also be clear of ears. A part pixel must be opaque in
     * that part and clear in every part drawn after it and in pip.
     */
    const ORDER = ['body', 'ears', 'plaster', 'muzzle', 'nose', 'mouth', 'eyes', 'paws'];
    const TARGETS = ['body', 'muzzle', 'nose', 'eyes', 'plaster'];

    function partSamples(frame: number): Map<string, [number, number][]> {
      const bruno = layerById('bruno');
      const parts = resolveLayer(bruno, scene, frame, registry).rig.parts ?? [];
      const pip = layerAlpha(layerById('pip'), frame);
      const alpha = new Map(parts.map((p) => [p, layerAlpha(bruno, frame, onlyParts([p]))]));
      const out = new Map<string, [number, number][]>();
      for (const target of TARGETS) {
        const own = alpha.get(target);
        if (!own) continue;
        const after = ORDER.slice(ORDER.indexOf(target) + 1)
          .filter((p) => p !== target)
          .map((p) => alpha.get(p))
          .filter((a): a is Uint8Array => a !== undefined);
        const blockers = [pip, ...after];
        const ok = new Uint8Array(W * H);
        for (let i = 0; i < ok.length; i++) {
          if (own[i] !== 255) continue;
          let clear = true;
          for (const b of blockers) {
            if (b[i] !== 0) {
              clear = false;
              break;
            }
          }
          if (clear) ok[i] = 1;
        }
        // Parts like the nose and eyes are small, so scan every pixel.
        const points: [number, number][] = [];
        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            if (
              ok[i] && ok[i - 1] && ok[i + 1] &&
              ok[i - W - 1] && ok[i - W] && ok[i - W + 1] &&
              ok[i + W - 1] && ok[i + W] && ok[i + W + 1]
            ) {
              points.push([x, y]);
            }
          }
        }
        const stride = Math.max(1, Math.floor(points.length / 3));
        out.set(target, points.filter((_, i) => i % stride === 0).slice(0, 3));
      }
      return out;
    }

    it.each([30, 60])('frame %i: interior pixels of bruno\'s parts return that part', (frame) => {
      const samples = partSamples(frame);
      const inOverride = frame >= 48 && frame < 72;
      const expected = inOverride ? TARGETS : TARGETS.filter((p) => p !== 'plaster');
      for (const part of expected) {
        expect(samples.get(part)?.length ?? 0, `${part} interior pixels on frame ${frame}`).toBeGreaterThan(0);
      }
      if (!inOverride) expect(samples.has('plaster')).toBe(false);

      const mismatches: string[] = [];
      for (const [part, points] of samples) {
        for (const [x, y] of points) {
          const hit = hitTest(probe, scene, frame, x + 0.5, y + 0.5, registry, { parts: true });
          if (hit.layerId !== 'bruno' || hit.partId !== part) {
            mismatches.push(`(${x}, ${y}) expected bruno/${part}, got ${hit.layerId}/${hit.partId}`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });
});
