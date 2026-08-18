import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode } from './timecode';

/**
 * What a moderator can type into a chapter's time box.
 *
 * <h2>Why this matters more than it looks</h2>
 * A rejected time shows an error and the moderator retypes it. A time that parses to the WRONG
 * number does not fail — the chapter is silently filed at the wrong moment, and nobody discovers it
 * until a viewer clicks "Item 4" and lands in the middle of item 2. The coercion cases below are
 * the ones that produce that outcome, which is why they are rejected rather than accepted loosely.
 */
describe('parseTimecode', () => {

  it('reads m:ss', () => {
    expect(parseTimecode('0:00')).toBe(0);
    expect(parseTimecode('12:40')).toBe(760);
  });

  it('reads h:mm:ss', () => {
    expect(parseTimecode('1:02:05')).toBe(3725);
  });

  it('accepts bare seconds, which is what a pasted transcript gives', () => {
    expect(parseTimecode('90')).toBe(90);
  });

  it('tolerates surrounding and internal whitespace', () => {
    expect(parseTimecode('  12:40  ')).toBe(760);
    expect(parseTimecode('1: 02 :05')).toBe(3725);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('   ')).toBeNull();
  });

  it('rejects more than three parts', () => {
    // Four colons is a typo, not a longer duration — no recording needs a days field.
    expect(parseTimecode('1:2:3:4')).toBeNull();
  });

  it('rejects an empty segment rather than reading it as zero', () => {
    // Number('') is 0, so a loose parse turns "::" into 0:00 — a real time nobody typed.
    expect(parseTimecode('::')).toBeNull();
    expect(parseTimecode('1::05')).toBeNull();
    expect(parseTimecode(':30')).toBeNull();
  });

  it('rejects exponent notation rather than reading it as a large number', () => {
    // Number('1e3') is 1000 — sixteen minutes into a recording, from a string that is not a time.
    expect(parseTimecode('1e3')).toBeNull();
  });

  it('rejects signed, decimal and non-numeric input', () => {
    expect(parseTimecode('-30')).toBeNull();
    expect(parseTimecode('1.5')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('12:4a')).toBeNull();
  });

  it('does not cap the seconds field, because 90 seconds is a fair way to say 1:30', () => {
    // Deliberate: rejecting it would be pedantry, and the arithmetic is unambiguous.
    expect(parseTimecode('0:90')).toBe(90);
  });
});

describe('formatTimecode', () => {

  it('omits the hour below an hour', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(760)).toBe('12:40');
  });

  it('includes the hour above one, zero-padding the minutes', () => {
    expect(formatTimecode(3725)).toBe('1:02:05');
  });

  it('floors rather than rounds, so a label never names a moment not yet reached', () => {
    expect(formatTimecode(59.9)).toBe('0:59');
  });

  it('clamps a negative to zero', () => {
    expect(formatTimecode(-5)).toBe('0:00');
  });

  it('round-trips with parseTimecode', () => {
    for (const seconds of [0, 5, 60, 760, 3725, 86399]) {
      expect(parseTimecode(formatTimecode(seconds))).toBe(seconds);
    }
  });
});
