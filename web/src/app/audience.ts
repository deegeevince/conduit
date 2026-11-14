// The person's audience preference (REVIEW-generality section 4): `adult` by default, `young` or `large-print`. Kept in the browser like the other
// preferences (look-and-fix, voice autosend); the stage and the lesson view read it, and the [+] menu's About sets it.

import { isAudience } from '../core/contracts';
import type { Audience } from '../core/contracts';

const KEY = 'conduit.audience';

export function readAudience(): Audience {
  try {
    const kept = window.localStorage.getItem(KEY);
    return isAudience(kept) ? kept : 'adult';
  } catch {
    return 'adult';
  }
}

export function writeAudience(audience: Audience): void {
  try {
    window.localStorage.setItem(KEY, audience);
  } catch {
    // for this visit only
  }
}
