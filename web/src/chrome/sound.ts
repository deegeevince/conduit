// The sound controls: a mute and a stop for the music, in the status row beside Show all. They appear only when there is music to
// hear or to silence (a tune is on stage, or is sounding), they are buttons like the rest of the bar, and they say in words what they do.
// `/stop` and the bar's Stop stop the music as well: `StageApp.interrupt` does it.

import type { StageApp } from '../app/stage-app';

export interface SoundControls {
  dispose(): void;
}

export function mountSound(host: HTMLElement, app: StageApp): SoundControls {
  const mute = document.createElement('button');
  mute.className = 'action action--sound';
  mute.type = 'button';
  mute.hidden = true;
  mute.setAttribute('aria-pressed', 'false');
  const stop = document.createElement('button');
  stop.className = 'action action--sound';
  stop.type = 'button';
  stop.hidden = true;
  stop.textContent = 'Stop music';
  stop.title = 'Stop the music (the picture stays)';
  host.append(mute, stop);

  const hasTune = (): boolean => app.painter.snapshot().elements.some((element) => element.kind === 'structure' && element.text.startsWith('tune'));

  const refresh = (): void => {
    const playing = app.sound.playing().length > 0;
    const shown = playing || hasTune() || app.sound.muted;
    const muted = app.sound.muted;
    mute.hidden = !shown && document.activeElement !== mute;
    mute.textContent = muted ? 'Unmute' : 'Mute';
    mute.title = muted ? 'Let the music be heard again' : 'Mute the music (the picture goes on)';
    mute.setAttribute('aria-pressed', String(muted));
    stop.hidden = !playing && document.activeElement !== stop;
    stop.setAttribute('aria-disabled', String(!playing));
  };

  mute.addEventListener('click', () => {
    app.sound.unlock();
    app.sound.mute(!app.sound.muted);
    app.announce(app.sound.muted ? 'Music muted' : 'Music on');
    refresh();
  });
  stop.addEventListener('click', () => {
    app.sound.stop();
    app.announce('Music stopped');
    refresh();
  });
  const off = app.sound.onChange(refresh);
  const timer = setInterval(refresh, 600);
  refresh();

  return {
    dispose() {
      clearInterval(timer);
      off();
      mute.remove();
      stop.remove();
    },
  };
}
