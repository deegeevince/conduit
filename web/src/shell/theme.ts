// The one bit that crosses from the stage to the shell: is the stage's ground light or dark. The stage writes its colours on the canvas's own
// root (`data-theme-root`) and, with them, the `color-scheme` it is drawn in; that is the only thing read, so the shell never wears a stage colour.

export type Scheme = 'light' | 'dark';

const media = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

/** The scheme the person's system asks for: what the shell wears while the canvas is shut. */
export function systemScheme(): Scheme {
  return media()?.matches === true ? 'dark' : 'light';
}

/** Whether the stage under `root` is drawn on a dark ground. */
export function stageScheme(root: HTMLElement): Scheme {
  return root.style.colorScheme === 'dark' ? 'dark' : 'light';
}

/** Hears the stage's ground change. Returns the way to stop. */
export function watchStage(root: HTMLElement, listener: (scheme: Scheme) => void): () => void {
  let last = stageScheme(root);
  const observer = new MutationObserver(() => {
    const next = stageScheme(root);
    if (next === last) return;
    last = next;
    listener(next);
  });
  observer.observe(root, { attributes: true, attributeFilter: ['style'] });
  return () => observer.disconnect();
}

/** Hears the system's choice change. */
export function watchSystem(listener: (scheme: Scheme) => void): () => void {
  const query = media();
  if (query === null) return () => undefined;
  const on = (): void => listener(query.matches ? 'dark' : 'light');
  query.addEventListener('change', on);
  return () => query.removeEventListener('change', on);
}

/** Puts the shell in one of its two fixed sets of colours. */
export function wear(scheme: Scheme): void {
  document.documentElement.dataset['theme'] = scheme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', scheme === 'dark' ? '#151518' : '#ffffff');
}
