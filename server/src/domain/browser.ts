// The owner's Chrome, as one more agent-mode service (`chrome`): Claude in Chrome's tools (`mcp__claude-in-chrome__*`), policed here.
//
// What the CLI gives (probed on this machine, Claude Code 2.1.325; the observations are at the top of brains/claude-cli/warm.ts): `--chrome`
// adds an MCP server named `claude-in-chrome` whatever `--strict-mcp-config` says, with no MCP configuration file, and `--tools` does not
// govern it; `--disallowedTools mcp__claude-in-chrome__<name>` removes a tool. The extension itself scopes every call to a tab group of
// this session's own, so the owner's other tabs are not reachable; the rules below are a second wall, not the only one.
//
// The rules, in code and not in the prompt (the same three as `agent.ts`, and these in addition):
//   1. THE BRAIN WORKS ONLY IN TABS IT OPENED. A call that names a tab the gate has not seen created (`tabs_context_mcp` with
//      `createIfEmpty` gives the session's own blank tab; `tabs_create_mcp` gives more) is denied, and so is a `navigate` with no tab.
//   2. READING IS FREE, ACTING IS ASKED. Screenshot, page text, page tree, find, console and the tab list are `read`. Navigation is `read` only
//      to a plain public http(s) address that cannot carry anything out (no query, no fragment, a short path); any other address asks.
//      Click, type, key, form input, file upload, javascript, download (a GIF export), tab create and tab close are asked, each time.
//   3. A SIGN-IN, PAYMENT OR CHECKOUT PAGE IS ALWAYS ASKED, AT THE HIGHEST RISK, and nothing is typed there, permit or none.
//   4. A CREDENTIAL IS NEVER TYPED. A password, a card number, a code, or anything shaped like a secret is refused outright by `gateCall`, even
//      when the owner would have allowed it; the model is told, and told that the owner types those themselves.
//
// What this reads of a tool's result is narrow and never leaves this file: tab ids and each tab's address (so a page that turned into a
// sign-in is known), and which fields of a page look like credential fields. Not a word of a page is kept, logged or sent.

import type { ActionRisk } from '@conduit/language';
import { redactSecrets, splitTool } from './agent';
import type { ToolCall } from './agent';

/** What the gate knows of the session's browser: the tabs it opened, where each is, and which have a credential field on them. */
export interface BrowserState {
  readonly tabs: Set<number>;
  readonly urls: Map<number, string>;
  /** tabs a read of the page showed a password, card or code field on, since the tab last navigated */
  readonly credentialTabs: Set<number>;
}

export function newBrowserState(): BrowserState {
  return { tabs: new Set(), urls: new Map(), credentialTabs: new Set() };
}

/** The tools of Claude in Chrome that are removed from the process altogether (`--disallowedTools`): each is an exit, a way to the owner's other browsers or files, or cannot be gated by what it names. */
export const CHROME_REMOVED: readonly string[] = [
  'browser_batch', // runs other tools inside one call; the gate sees only the batch, so each action would go unasked
  'gif_creator', // a download
  'javascript_tool', // runs code in the page
  'file_upload', // sends a local file to a page
  'upload_image', // sends a screenshot to a page
  'resize_window', // moves the owner's window
  'select_browser',
  'switch_browser', // opens a confirmation screen in every connected Chrome
  'list_connected_browsers',
  'read_network_requests', // requests carry what a page was given
];

export const CHROME_SERVER = 'claude-in-chrome';

const READ_COMPUTER_ACTIONS: readonly string[] = ['screenshot', 'zoom', 'scroll', 'scroll_to', 'hover', 'wait'];
const READ_TOOLS: readonly string[] = ['get_page_text', 'read_page', 'find', 'read_console_messages'];
/** Keys that are not characters: pressing them types nothing. */
const NAMED_KEYS: readonly string[] = ['enter', 'return', 'tab', 'escape', 'esc', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown', 'home', 'end', 'space'];

const SIGNIN_WORDS = /(?:^|[/._?=&#-])(?:log-?in|sign-?in|sign_in|sign-?up|signup|register|auth|oauth2?|sso|saml|password|passwd|forgot|reset|2fa|mfa|otp|verify|verification|session|credentials?)(?:$|[/._?=&#-])/i;
const SIGNIN_HOSTS = /^(?:accounts|account|login|signin|auth|id|sso|idp|identity|secure|myaccount)\./i;
const PAYMENT_WORDS = /(?:^|[/._?=&#-])(?:checkout|check-out|payments?|pay|billing|purchase|order|orders|cart|basket|subscribe|subscription|upgrade|invoice|card|wallet|donate|transfer|withdraw|deposit)(?:$|[/._?=&#-])/i;
const PAYMENT_HOSTS = /^(?:checkout|pay|payments?|billing|secure-?pay)\.|(?:^|\.)(?:paypal|stripe|checkout\.com|adyen|klarna|venmo|wise)\.(?:com|net|me)$/i;

/** What the address of a page says about it: a sign-in (the owner's own hands), a payment or checkout, or nothing. The address is read whole, host and path and query. */
export function sensitivityOf(raw: string): 'signin' | 'buy' | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const rest = `${decodeURIComponent(url.pathname.replace(/%(?![0-9a-f]{2})/gi, ''))}${url.search}${url.hash}`;
  if (SIGNIN_HOSTS.test(host) || SIGNIN_WORDS.test(rest)) return 'signin';
  if (PAYMENT_HOSTS.test(host) || PAYMENT_WORDS.test(rest)) return 'buy';
  return null;
}

const RISK_ORDER: readonly ActionRisk[] = ['read', 'write', 'run', 'send', 'buy', 'delete', 'publish', 'signin'];
const worse = (a: ActionRisk, b: ActionRisk): ActionRisk => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a);

/** A public address that carries nothing out: http(s), no credential, no private host, no query, no fragment, a short path. */
function quietAddress(raw: string): 'quiet' | 'loud' | 'refused' {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return 'refused';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'refused';
  if (url.username !== '' || url.password !== '') return 'refused';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || host.startsWith('[') || /^\d+$/.test(host) || !host.includes('.')) return 'refused';
  return url.search !== '' || url.hash !== '' || url.pathname.length > 100 || raw.length > 300 ? 'loud' : 'quiet';
}

export interface BrowserVerdict {
  readonly risk: ActionRisk;
  /** set: never allowed, not even by the owner; this is what the brain is told */
  readonly deny: string | null;
  /** the call is aimed at a sign-in, payment or checkout page (or goes to one): always asked, at every permit level */
  readonly sensitive: boolean;
}

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

/** Whether text about to be typed is a credential: shaped like a secret, a card number, or a one-time code. A sentence that merely mentions a password is not. */
export function looksLikeCredential(text: string): boolean {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain === '') return false;
  if (redactSecrets(plain, Math.max(plain.length + 20, 200)) !== plain) return true;
  const digits = plain.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return true;
  if (/^\d{6,8}$/.test(plain)) return true;
  return false;
}

const CREDENTIAL_WORDS = /\b(?:password|passcode|passphrase|pwd|cvv|cvc|security code|card number|one-?time|verification code|2fa|otp|ssn|social security)\b/i;

export const CREDENTIALS_NEVER = 'typing a password, card number, code or any other credential is never allowed, with or without a permit: the owner types those themselves. Say so, and ask them to do that step in their own browser';

const tabOf = (call: ToolCall): number | null => {
  const id = call.input['tabId'];
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
};

/**
 * What a Claude in Chrome call would do and whether it may be done at all. `state` is what the gate has learned of this session's tabs
 * from earlier results (`noteBrowserResult`); a fresh state is a session that has opened no tab yet.
 */
export function browserVerdict(call: ToolCall, state: BrowserState): BrowserVerdict {
  const { action: name } = splitTool(call.tool);
  const input = call.input;
  const refuse = (why: string, risk: ActionRisk = 'run'): BrowserVerdict => ({ risk, deny: why, sensitive: false });
  const ask = (risk: ActionRisk, sensitive = false): BrowserVerdict => ({ risk, deny: null, sensitive });

  if (name === 'browser_batch') return refuse('browser_batch is not available: make each call on its own, so that each is shown and approved');
  if (CHROME_REMOVED.includes(name)) return refuse(`${name} is not available in this browser`);
  if (name === 'tabs_context_mcp') return ask(input['createIfEmpty'] === true ? 'write' : 'read');
  if (name === 'tabs_create_mcp') return ask('write');

  const tab = tabOf(call);
  if (tab === null || !state.tabs.has(tab)) {
    return refuse('the browser is used only in tabs you opened yourself: call tabs_context_mcp with createIfEmpty to get your own tab, or tabs_create_mcp, and name its tabId');
  }
  if (name === 'tabs_close_mcp') return ask('write');

  const here = state.urls.get(tab) ?? null;
  const onSensitive = here === null ? null : sensitivityOf(here);

  // Typing: never a credential, never on a sign-in or payment page, never where a read showed a credential field.
  const typing = name === 'form_input' || (name === 'computer' && input['action'] === 'type');
  const keys = name === 'computer' && input['action'] === 'key';
  if (typing || keys) {
    const said = [input['action_summary'], input['ref']].filter((value): value is string => typeof value === 'string').join(' ');
    const value = name === 'form_input' ? input['value'] : input['text'];
    const written = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    if (onSensitive !== null) return refuse(`${CREDENTIALS_NEVER}. This page looks like a ${onSensitive === 'signin' ? 'sign-in' : 'payment or checkout'} page, so nothing is typed on it`, onSensitive);
    if (keys && !written.toLowerCase().split(/\s+/).every((key) => key === '' || NAMED_KEYS.includes(key) || /^(?:cmd|ctrl|meta|alt|shift|control|command)(?:\+.+)?$/i.test(key))) {
      if (state.credentialTabs.has(tab) || looksLikeCredential(written)) return refuse(CREDENTIALS_NEVER, 'signin');
    }
    if (typing) {
      if (state.credentialTabs.has(tab)) return refuse(`${CREDENTIALS_NEVER}. A password, card or code field is on this page, so nothing is typed on it`, 'signin');
      if (looksLikeCredential(written) || CREDENTIAL_WORDS.test(said)) return refuse(CREDENTIALS_NEVER, 'signin');
    }
  }

  let risk: ActionRisk;
  let targetSensitive = false;
  if (name === 'navigate') {
    const target = input['url'];
    if (typeof target !== 'string' || target.trim() === '') return refuse('navigate needs a url');
    if (/^(?:back|forward)$/i.test(target.trim())) risk = 'run';
    else {
      const sens = sensitivityOf(target);
      if (sens !== null) targetSensitive = true;
      const quiet = quietAddress(target.trim());
      if (quiet === 'refused') risk = 'run';
      else risk = sens ?? (quiet === 'quiet' ? 'read' : 'send');
    }
  } else if (READ_TOOLS.includes(name)) risk = 'read';
  else if (name === 'computer') risk = typeof input['action'] === 'string' && READ_COMPUTER_ACTIONS.includes(input['action']) ? 'read' : 'run';
  else risk = 'run';

  // Anything on a page that is a sign-in, payment or checkout is asked for, and at the highest risk.
  return ask(onSensitive === null ? risk : worse(risk, onSensitive), onSensitive !== null || targetSensitive);
}

/** The words a tab's own address and the ids in one JSON block of `tabs_context_mcp`; never page text. */
const TAB_LINE = /^\s*[•*-]?\s*tabId (\d+): "[^\n]*?" \("([^"\n]*)"\)\s*$/gm;

/**
 * Learns from what a Chrome tool returned: the tabs this session now owns, where each is, and whether a page showed a credential field.
 * Called with the result's text blocks, for a call that ended well. Only structured facts are kept; the text is dropped.
 */
export function noteBrowserResult(state: BrowserState, call: ToolCall, texts: readonly string[]): void {
  const { action: name } = splitTool(call.tool);
  const joined = texts.join('\n');
  if (name === 'tabs_create_mcp' || name === 'tabs_context_mcp') {
    // Only the structured block counts for ownership: a page's title is the page's, and cannot name a tab into the set.
    for (const block of texts) {
      if (!block.startsWith('{"availableTabs"')) continue;
      try {
        const parsed = JSON.parse(block) as { availableTabs?: readonly { tabId?: unknown; url?: unknown }[] };
        for (const entry of parsed.availableTabs ?? []) {
          if (typeof entry.tabId !== 'number') continue;
          // A tab becomes the brain's own when it made it (`tabs_create_mcp`) or it is the blank one a new session group opens with; a tab
          // that is merely listed, in a group that was there before, is not.
          const blank = typeof entry.url === 'string' && entry.url.startsWith('chrome://newtab');
          if (!(state.tabs.has(entry.tabId) || blank || name === 'tabs_create_mcp')) continue;
          state.tabs.add(entry.tabId);
          if (typeof entry.url === 'string') state.urls.set(entry.tabId, entry.url);
        }
      } catch {
        // not the block we thought it was
      }
    }
    if (name === 'tabs_create_mcp') {
      // The answer's shape for a new tab was not probed (the probe made one tab only); it is read three ways, the blank tab among the
      // tabs listed being the new one, and then the first id the prose names.
      const before = new Set(state.tabs);
      for (const match of joined.matchAll(TAB_LINE)) {
        const id = Number(match[1]);
        if (!before.has(id) && (match[2] ?? '').startsWith('chrome://newtab')) state.tabs.add(id);
      }
      if (state.tabs.size === before.size) {
        const made = /tab ?id\D{0,12}(\d+)/i.exec(joined);
        if (made?.[1] !== undefined) state.tabs.add(Number(made[1]));
      }
    }
  }
  if (name === 'tabs_close_mcp') {
    const id = tabOf(call);
    if (id !== null) {
      state.tabs.delete(id);
      state.urls.delete(id);
      state.credentialTabs.delete(id);
    }
    return;
  }
  // Each result of a call on a tab carries "Tab Context": the first line naming a tab is the real one.
  const seen = new Set<number>();
  for (const match of joined.matchAll(TAB_LINE)) {
    const id = Number(match[1]);
    if (seen.has(id) || !state.tabs.has(id)) continue;
    seen.add(id);
    const before = state.urls.get(id);
    const now = match[2] ?? '';
    if (before !== now) state.credentialTabs.delete(id);
    state.urls.set(id, now);
  }
  const id = tabOf(call);
  if (id !== null && name === 'navigate' && typeof call.input['url'] === 'string' && !seen.has(id)) {
    state.urls.set(id, call.input['url']);
    state.credentialTabs.delete(id);
  }
  if (id !== null && (name === 'read_page' || name === 'find') && /\[ref_\d+\]|ref_\d+/.test(joined)) {
    for (const line of joined.split('\n')) {
      if (/ref_\d+/.test(line) && (/\btype="?password"?|\bpassword\b|\bpasscode\b|card number|credit card|\bcvv\b|\bcvc\b|security code|one-time|verification code/i.test(line))) state.credentialTabs.add(id);
    }
  }
}
