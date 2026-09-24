import { describe, expect, it } from 'vitest';
import { optionsFromQuery } from './player';

describe('optionsFromQuery', () => {
  it('leaves everything to the defaults without a query', () => {
    expect(optionsFromQuery('')).toEqual({ autoplay: undefined, loop: undefined, frame: undefined });
  });

  it('turns autoplay and loop off with 0, false, no or off, and on with anything else', () => {
    expect(optionsFromQuery('?autoplay=0&loop=false')).toMatchObject({ autoplay: false, loop: false });
    expect(optionsFromQuery('?autoplay=NO&loop=off')).toMatchObject({ autoplay: false, loop: false });
    expect(optionsFromQuery('?autoplay=1&loop')).toMatchObject({ autoplay: true, loop: true });
  });

  it('reads a whole starting frame and ignores anything else', () => {
    expect(optionsFromQuery('?frame=47').frame).toBe(47);
    expect(optionsFromQuery('?frame=4.5').frame).toBeUndefined();
    expect(optionsFromQuery('?frame=abc').frame).toBeUndefined();
    expect(optionsFromQuery('?frame=').frame).toBeUndefined();
  });
});
