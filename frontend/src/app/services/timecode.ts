/**
 * Parsing the times a moderator types when marking up an agenda.
 *
 * <p>Its own module rather than a method on the admin component, because the rules are worth testing
 * on their own and a component method cannot be reached without standing up Angular's DI. It is also
 * the half of chapter editing most likely to be wrong in a way nobody notices: a mis-parse does not
 * fail, it silently files the chapter at the wrong moment.
 */

/**
 * "1:02:05" / "12:40" / "90" to seconds. Null when the text is not a time.
 *
 * <p>Bare seconds are accepted because that is what somebody pasting from a script or a transcript
 * tool has. Anything else is rejected rather than coerced — see the digit check below.
 */
export function parseTimecode(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':');
  // h:mm:ss is the longest form a recording can need; more colons is a typo, not a longer time.
  if (parts.length > 3) return null;

  let seconds = 0;
  for (const part of parts) {
    // Digits only, and deliberately strict. Number('') is 0 and Number('1e3') is 1000, so a loose
    // check turns "::" into 0:00 and "1e3" into a quarter of an hour — both plausible-looking times
    // that nobody typed, filed against a recording where nobody will notice they are wrong.
    if (!/^\d+$/.test(part.trim())) return null;
    seconds = seconds * 60 + Number(part.trim());
  }
  return seconds;
}

/** Seconds to h:mm:ss / m:ss, matching how the player labels the same moment. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
