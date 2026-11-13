import { errors } from '../errors';
import type { ImageModel } from '../domain/images';

/** Stands in when no image model is configured: every painting is skipped and the sketch is all there is. */
export const NO_IMAGE_MODEL: ImageModel = {
  id: 'none',
  available: false,
  generate: () => Promise.reject(errors.imageFailed('no image model is configured')),
};
