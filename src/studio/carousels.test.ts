import { describe, expect, it } from 'vitest';
import { validateFolderProject } from '../engine';
import { applyCarouselEdit, carouselOf, checkCarouselEdit, freshSlideId, slideFileName, type Carousel } from './carousels';

const launch: Carousel = { id: 'launch', slides: ['launch-1', 'launch-2', 'launch-3'] };
const tips: Carousel = { id: 'tips', slides: ['tip-a'] };

describe('carousels (ADR 0022)', () => {
  it('find a still\'s carousel and its place', () => {
    expect(carouselOf([launch, tips], 'launch-2')).toEqual({ carousel: launch, index: 1 });
    expect(carouselOf([launch, tips], 'loose')).toBeNull();
    expect(carouselOf(undefined, 'launch-1')).toBeNull();
  });

  it('are created, added to, reordered, taken from and ungrouped', () => {
    expect(applyCarouselEdit([], { op: 'create', id: 'launch', slides: ['a', 'b'] })).toEqual([{ id: 'launch', slides: ['a', 'b'] }]);
    expect(applyCarouselEdit([launch], { op: 'add', carousel: 'launch', scene: 'x' })[0].slides).toEqual(['launch-1', 'launch-2', 'launch-3', 'x']);
    expect(applyCarouselEdit([launch], { op: 'add', carousel: 'launch', scene: 'x', at: 1 })[0].slides).toEqual(['launch-1', 'x', 'launch-2', 'launch-3']);
    expect(applyCarouselEdit([launch], { op: 'move', carousel: 'launch', scene: 'launch-3', to: 0 })[0].slides).toEqual(['launch-3', 'launch-1', 'launch-2']);
    expect(applyCarouselEdit([launch], { op: 'move', carousel: 'launch', scene: 'launch-1', to: 99 })[0].slides).toEqual(['launch-2', 'launch-3', 'launch-1']);
    expect(applyCarouselEdit([launch], { op: 'remove', carousel: 'launch', scene: 'launch-2' })[0].slides).toEqual(['launch-1', 'launch-3']);
    expect(applyCarouselEdit([launch, tips], { op: 'delete', carousel: 'launch' })).toEqual([tips]);
    // The input is never changed.
    expect(launch.slides).toEqual(['launch-1', 'launch-2', 'launch-3']);
  });

  it('keep a still in one carousel: adding it elsewhere moves it, and an emptied carousel goes', () => {
    expect(applyCarouselEdit([launch, tips], { op: 'add', carousel: 'launch', scene: 'tip-a' })).toEqual([{ id: 'launch', slides: ['launch-1', 'launch-2', 'launch-3', 'tip-a'] }]);
    expect(applyCarouselEdit([launch, tips], { op: 'create', id: 'mix', slides: ['launch-1', 'tip-a'] })).toEqual([
      { id: 'launch', slides: ['launch-2', 'launch-3'] },
      { id: 'mix', slides: ['launch-1', 'tip-a'] },
    ]);
    expect(applyCarouselEdit([tips], { op: 'remove', carousel: 'tips', scene: 'tip-a' })).toEqual([]);
  });

  it('refuse what makes no sense, with the reason', () => {
    expect(() => applyCarouselEdit([launch], { op: 'create', id: 'launch', slides: ['a'] })).toThrow(/already a carousel "launch"/);
    expect(() => applyCarouselEdit([], { op: 'create', id: 'Launch!', slides: ['a'] })).toThrow(/lowercase/);
    expect(() => applyCarouselEdit([], { op: 'create', id: 'x', slides: [] })).toThrow(/at least one/);
    expect(() => applyCarouselEdit([], { op: 'create', id: 'x', slides: ['a', 'a'] })).toThrow(/once/);
    expect(() => applyCarouselEdit([launch], { op: 'add', carousel: 'nope', scene: 'a' })).toThrow(/no carousel "nope"/);
    expect(() => applyCarouselEdit([launch], { op: 'move', carousel: 'launch', scene: 'nope', to: 0 })).toThrow(/isn't a slide/);
    expect(checkCarouselEdit({ op: 'move', carousel: 'launch', scene: 'a', to: -1 })).toMatch(/move takes/);
    expect(checkCarouselEdit({ op: 'shuffle' })).toMatch(/unknown carousel edit/);
    expect(checkCarouselEdit({ op: 'create', id: 'x', slides: ['a'] })).toBeNull();
    expect(checkCarouselEdit([])).toMatch(/JSON object/);
  });

  it('name exported slides so the folder sorts as the post swipes, and new slides after the carousel', () => {
    expect(slideFileName(0, 'launch-1', 'png')).toBe('01-launch-1.png');
    expect(slideFileName(11, 'cta', 'jpg')).toBe('12-cta.jpg');
    expect(freshSlideId('launch', new Set(['launch-1', 'launch-2', 'launch-4']))).toBe('launch-3');
  });

  it('are checked in project.json', () => {
    const errors = (carousels: unknown) => {
      const r = validateFolderProject({ carousels });
      return r.ok ? [] : r.errors;
    };
    expect(errors([launch, tips])).toEqual([]);
    expect(errors({}).join()).toMatch(/must be a list/);
    expect(errors([{ id: 'Launch', slides: ['a'] }]).join()).toMatch(/carousels\[0\]\.id/);
    expect(errors([launch, { id: 'launch', slides: ['z'] }]).join()).toMatch(/duplicate carousel "launch"/);
    expect(errors([{ id: 'a', slides: [] }]).join()).toMatch(/at least one/);
    expect(errors([launch, { id: 'other', slides: ['launch-2'] }]).join()).toMatch(/"launch-2" is already a slide of "launch"/);
    expect(errors([{ id: 'a', slides: ['x'], cover: 'x' }]).join()).toMatch(/unknown field "cover"/);
  });
});
