// The part of fontkit (MIT, a dev dependency) the typeface converter uses.
declare module 'fontkit' {
  export interface PathCommand {
    command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
    args: number[];
  }
  export interface Glyph {
    id: number;
    advanceWidth: number;
    path: { commands: PathCommand[] };
  }
  export interface GlyphRun {
    glyphs: Glyph[];
    positions: { xAdvance: number; xOffset: number }[];
  }
  export interface Font {
    familyName: string;
    subfamilyName: string;
    copyright: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    lineGap: number;
    capHeight: number;
    xHeight: number;
    variationAxes: Record<string, { name: string; min: number; default: number; max: number }>;
    getVariation(settings: Record<string, number>): Font;
    glyphForCodePoint(codePoint: number): Glyph;
    getGlyph(id: number): Glyph;
    hasGlyphForCodePoint(codePoint: number): boolean;
    layout(text: string, features?: Record<string, boolean> | string[]): GlyphRun;
  }
  export function openSync(path: string): Font;
}
