/**
 * Hit testing by per-layer alpha probes, in place of a flat-colour ID pass.
 *
 * Algorithm. The probe is a 2D context of which only pixel (0, 0) is used.
 * It is reset, then translated by (-floor(x), -floor(y)) so that scene pixel
 * lands on (0, 0). Layers are walked top first. Each one is drawn alone
 * through drawLayer, the same code the visible render runs, onto the cleared
 * pixel, and only its alpha `a` is read back. The layer's share of the visible
 * pixel is `transmit * a`, where `transmit` is what the layers above let
 * through (it starts at 1 and becomes `transmit * (1 - a)`). The largest share
 * wins; ties go to the upper layer. The scan stops once `transmit` is no more
 * than the best share, since nothing below can then win; `options.all` scans
 * every layer anyway, which only adds candidates.
 *
 * With `options.parts`, the winning layer is drawn once more with a kit that
 * reads and clears the pixel at every part boundary. Each segment between
 * boundaries gets its own alpha, and segments are weighed like layers, from
 * the last one drawn back. A part drawn in several segments owns the sum of
 * their shares.
 *
 * The pixel is cleared with putImageData and read with getImageData, which
 * the transform, clip, alpha and compositing do not affect. Answers can
 * differ from the visible canvas only on the antialiased one-pixel edge.
 *
 * Research and trade-offs: .scratch/frame-studio/research/id-pass-antialiasing.md,
 * "Recommendation for M2".
 */
import { assertFrame, drawLayer } from './render';
import { resolveLayer, sceneLayers } from './resolve';
import type { Ctx2D, DrawKit, Layer, RigRegistry, Scene, World } from './types';

/** One layer with paint at the probed pixel. */
export interface HitCandidate {
  layerId: string;
  /** The layer's own alpha at the pixel, 0 to 1. */
  alpha: number;
  /** How much of the visible pixel this layer contributes after the layers above it: transmit * alpha. */
  share: number;
}

export interface HitResult {
  /** The layer contributing most to the visible pixel, or null when nothing painted it. */
  layerId: string | null;
  /** The winning layer's part at the pixel, when options.parts is set and the rig declares parts. */
  partId?: string;
  /** Layers with nonzero alpha at the pixel, top first. Without options.all the scan stops early. */
  candidates: HitCandidate[];
}

export interface HitTestOptions {
  /** Scan every layer instead of stopping once nothing below can win. */
  all?: boolean;
  /** Also find the part of the winning layer. */
  parts?: boolean;
  /** A project scene's world (ADR 0007). A scene layer hits as one layer, the shot it places. */
  world?: World;
}

/**
 * Which layer is at scene pixel (x, y) on this frame. Draws each layer on its
 * own through drawLayer into `probe`, translated so the pixel lands at (0, 0),
 * top layer first, and reads back only alpha.
 *
 * `probe` is scratch: hitTest resets it (state, save stack, clip and pixels)
 * before use, so pass a context kept for probing, such as
 * `new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })`.
 * Throws RangeError unless frame is an integer in [0, frameCount(scene)).
 */
export function hitTest(
  probe: Ctx2D,
  scene: Scene,
  frame: number,
  x: number,
  y: number,
  registry: RigRegistry,
  options: HitTestOptions = {},
): HitResult {
  assertFrame(scene, frame);
  const [width, height] = scene.size;
  if (!(x >= 0 && x < width && y >= 0 && y < height)) return { layerId: null, candidates: [] };

  resetProbe(probe);
  probe.save();
  try {
    probe.setTransform(1, 0, 0, 1, -Math.floor(x), -Math.floor(y));
    const pixel = probePixel(probe);
    const layers = sceneLayers(scene);
    const candidates: HitCandidate[] = [];
    let winner: Layer | undefined;
    let bestShare = 0;
    let transmit = 1;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      pixel.clear();
      drawLayer(probe, scene, layer, frame, registry, undefined, options.world);
      const alpha = pixel.alpha();
      if (alpha > 0) {
        const share = transmit * alpha;
        candidates.push({ layerId: layer.id, alpha, share });
        if (share > bestShare) {
          bestShare = share;
          winner = layer;
        }
        transmit *= 1 - alpha;
      }
      if (!options.all && transmit <= bestShare) break;
    }
    if (!winner) return { layerId: null, candidates };

    const result: HitResult = { layerId: winner.id, candidates };
    if (options.parts) {
      const partId = partAt(probe, pixel, scene, winner, frame, registry, options.world ?? {});
      if (partId !== undefined) result.partId = partId;
    }
    return result;
  } finally {
    probe.restore();
  }
}

interface ProbePixel {
  /** Make pixel (0, 0) transparent, whatever the clip, transform or compositing. */
  clear(): void;
  /** Alpha of pixel (0, 0), 0 to 1. */
  alpha(): number;
}

function probePixel(probe: Ctx2D): ProbePixel {
  const empty = probe.createImageData(1, 1);
  return {
    clear: () => probe.putImageData(empty, 0, 0),
    alpha: () => probe.getImageData(0, 0, 1, 1).data[3] / 255,
  };
}

/** Drop any state, clip and save stack the caller left, so they cannot change answers. */
function resetProbe(probe: Ctx2D): void {
  if (typeof probe.reset === 'function') {
    probe.reset();
  } else {
    // Browsers without reset() (Safari before 18) reset a context when its canvas is resized.
    const canvas = probe.canvas;
    canvas.width = canvas.width;
  }
}

/**
 * The part of `layer` that contributes most to the probed pixel, or undefined
 * when the rig declares no parts or the winning segment is outside any part.
 */
function partAt(probe: Ctx2D, pixel: ProbePixel, scene: Scene, layer: Layer, frame: number, registry: RigRegistry, world: World): string | undefined {
  // A scene layer's shot is picked inside by opening the shot; a masked layer draws on a surface, where parts can't be read.
  if (layer.scene !== undefined || layer.mask) return undefined;
  const { rig } = resolveLayer(layer, scene, frame, registry, world);
  if (!rig.parts || rig.parts.length === 0) return undefined;

  const segments: { partId: string | undefined; alpha: number }[] = [];
  let current: string | undefined;
  const cut = () => {
    segments.push({ partId: current, alpha: pixel.alpha() });
    pixel.clear();
  };
  const kit: DrawKit = {
    part(id, draw) {
      cut();
      const outer = current;
      current = id;
      try {
        draw();
      } finally {
        cut();
        current = outer;
      }
    },
  };
  pixel.clear();
  drawLayer(probe, scene, layer, frame, registry, kit, world);
  cut();

  // A part drawn in several segments owns the sum of their shares. Map keeps
  // first-insertion order, so on a tie the part seen first from the top wins.
  const shares = new Map<string | undefined, number>();
  let transmit = 1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const { partId, alpha } = segments[i];
    if (alpha > 0) shares.set(partId, (shares.get(partId) ?? 0) + transmit * alpha);
    transmit *= 1 - alpha;
  }
  let best: string | undefined;
  let bestShare = 0;
  for (const [partId, share] of shares) {
    if (share > bestShare) {
      bestShare = share;
      best = partId;
    }
  }
  return best;
}
