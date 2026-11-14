import type { PictureService, PictureSource } from '../domain/pictures';

/** No source is switched on: every `image` line keeps its placeholder. */
export const NO_PICTURE_SOURCE: PictureSource = { id: 'none', available: false, search: () => Promise.resolve([]) };
export const NO_PICTURES: PictureService = { id: 'none', available: false, find: () => Promise.resolve(null), get: () => Promise.resolve(null) };
