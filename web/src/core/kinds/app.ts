// kinds/app.ts: The live app's place on the stage (`painter/blocks/app.ts`: its title, its lines arriving as a
// skeleton, its frame) wrapped; the app itself runs in the sandboxed host, which the core lays over the box this kind is given. Ready where
// there is an app host (`appHost` in the painter), as `Capabilities.structures` has it today.

import { layoutApp } from '../../painter/blocks/app';
import { seal } from '../seal';
import { structureKind } from './adapt-structure';

export const app = seal(
  structureKind({
    id: 'app',
    engine: layoutApp,
    fit: 'contain',
    status: { state: 'host', host: 'app' },
    surface: 'app',
    fixtures: [['app tally height=200 | Tally', '| <div id="n">0</div>', '| <button id="add">Add one</button>', '| <script>document.getElementById("add").onclick = function () {};</script>']],
  }),
);
