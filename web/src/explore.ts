// Entry for explore.html. Two pages share the file:
//   explore.html            the review page of the evaluation harness (explore/page.ts)
//   explore.html#harness    the runner's eyes: no UI, `window.__harness` for the headless browser the runner drives
//                           to make the pictures its judge looks at (explore/harness.ts)
// The review page needs the server only for the run files; it never calls a brain.

import './explore/explore.css';

if (location.hash.startsWith('#harness')) {
  void import('./explore/harness').then((module) => module.installHarness());
} else {
  void import('./explore/page').then((module) => module.startPage());
}
