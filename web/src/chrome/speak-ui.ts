// Read aloud, what the person works: a speaker switch in the message box beside the microphone, and a small panel in the [+] menu for the voice and the pace.
// The switch is "Read aloud", on or off, kept on that device. While something is being said it shows that, and pressing it then is "Stop speaking" (the
// switch stays on). With no voice on the device it says so and stays off.

import type { ComposerMenu } from './menu';
import { PACES } from './speak';
import type { Pace, Speaker } from './speak';

const WAVES = '<svg class="speak__waves" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path class="speak__w1" d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path class="speak__w2" d="M18.5 7a7 7 0 0 1 0 10"/></svg>';
const OFF = '<path class="speak__off" d="M3.5 3.5l17 17"/>';
const STOP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';

const PACE_LABEL: Readonly<Record<Pace, string>> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
const PACE_GIST: Readonly<Record<Pace, string>> = { slow: 'for reading along', normal: 'the voice as it comes', fast: 'quicker' };

const NO_VOICE = 'Read aloud needs a voice on this device. Add one in Settings, Accessibility, Spoken Content, Voices.';

let counter = 0;

export interface SpeakUi {
  dispose(): void;
}

/**
 * `button` is made and put in the bar by the caller (so the bar's layout stays its own); `say` shows a short line (the bar's note) that goes by itself.
 */
export function mountSpeak(button: HTMLButtonElement, speaker: Speaker, menu: ComposerMenu, say: (text: string) => void): SpeakUi {
  counter += 1;
  const id = `speak-${counter}`;
  button.hidden = !speaker.supported;
  button.setAttribute('aria-pressed', 'false');

  const draw = (): void => {
    const speaking = speaker.on && speaker.speaking;
    button.classList.toggle('speak--on', speaker.on);
    button.classList.toggle('speak--speaking', speaking);
    button.setAttribute('aria-pressed', String(speaker.on));
    button.dataset['state'] = speaking ? 'speaking' : speaker.on ? 'on' : 'off';
    if (speaking) {
      button.innerHTML = STOP;
      button.setAttribute('aria-label', 'Stop speaking');
      button.title = 'Stop speaking (Read aloud stays on)';
    } else {
      button.innerHTML = speaker.on ? WAVES : WAVES.replace('</svg>', `${OFF}</svg>`);
      button.setAttribute('aria-label', speaker.on ? 'Read aloud: on. Press to turn off' : 'Read aloud: off. Press to turn on');
      button.title = speaker.on ? 'Read aloud is on (tap to turn off)' : 'Read answers aloud (this device\'s own voice, nothing is sent anywhere)';
    }
  };

  button.addEventListener('click', () => {
    if (speaker.on && speaker.speaking) {
      speaker.stop();
      return;
    }
    if (speaker.on) {
      speaker.setOn(false);
      return;
    }
    // inside the tap: iOS lets speech begin only here
    speaker.setOn(true);
    if (!speaker.on) say(NO_VOICE);
  });

  // ---- voice and pace, in the [+] menu
  const panel = menu.addView('speak', 'Read aloud');
  panel.classList.add('picker__panel');
  const entry = menu.add({ id: 'speak', label: 'Voice and speed', gist: '', order: 45, view: 'speak', hidden: !speaker.supported });

  const radios = (name: string, legend: string, rows: readonly { readonly value: string; readonly text: string; readonly gist?: string }[], current: string): HTMLFieldSetElement => {
    const set = document.createElement('fieldset');
    set.className = 'picker__group';
    const title = document.createElement('legend');
    title.textContent = legend;
    set.append(title);
    for (const row of rows) {
      counter += 1;
      const label = document.createElement('label');
      label.className = 'picker__option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `${name}-${id}`;
      input.value = row.value;
      input.checked = row.value === current;
      input.dataset['field'] = name;
      input.id = `${id}-${name}-${counter}`;
      const text = document.createElement('span');
      text.textContent = row.text;
      label.append(input, text);
      if (row.gist !== undefined) {
        const note = document.createElement('span');
        note.className = 'picker__gist';
        note.id = `${input.id}-gist`;
        note.textContent = row.gist;
        input.setAttribute('aria-describedby', note.id);
        label.append(note);
      }
      set.append(label);
    }
    return set;
  };

  const drawPanel = (): void => {
    const voices = speaker.voices();
    const using = speaker.voice();
    const parts: HTMLElement[] = [];
    if (voices.length === 0) {
      const none = document.createElement('p');
      none.className = 'picker__note';
      none.textContent = NO_VOICE;
      parts.push(none);
    } else {
      parts.push(radios('voice', 'Voice', voices.map((voice) => ({ value: voice.voiceURI, text: voice.name, gist: voice.lang })), using?.voiceURI ?? ''));
    }
    parts.push(radios('pace', 'Speed', PACES.map((pace) => ({ value: pace, text: PACE_LABEL[pace], gist: PACE_GIST[pace] })), speaker.pace));
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'picker__option speak__try';
    preview.dataset['field'] = 'try';
    preview.textContent = 'Hear it';
    parts.push(preview);
    const note = document.createElement('p');
    note.className = 'picker__note';
    note.textContent = 'Spoken by this device; nothing is sent anywhere. Enhanced and Premium voices sound best: add them in Settings, Accessibility, Spoken Content, Voices.';
    parts.push(note);
    panel.replaceChildren(...parts);
    const name = using === null ? 'none on this device' : using.name;
    entry.set({ gist: `${name}, ${PACE_LABEL[speaker.pace].toLowerCase()}` });
  };

  panel.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset['field'] === 'voice') speaker.setVoice(target.value);
    else if (target.dataset['field'] === 'pace') {
      const pace = PACES.find((item) => item === target.value);
      if (pace !== undefined) speaker.setPace(pace);
    }
  });
  panel.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('[data-field="try"]') === null) return;
    speaker.sample('This is how I will read to you.');
  });

  const off = speaker.subscribe(() => {
    draw();
    // redrawing under a finger that is on a radio would lose its place
    if (!panel.contains(document.activeElement)) drawPanel();
  });
  draw();
  drawPanel();

  return {
    dispose() {
      off();
      entry.remove();
      panel.remove();
    },
  };
}
