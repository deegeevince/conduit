import type { ImageModel } from '../domain/images';
import type { ImageSettings } from '../env';
import type { Logger } from '../log';
import { NO_IMAGE_MODEL } from './none';

/** The image model: there is none. Every painting is skipped and the sketch is all there is. */
export function createImageModel(_settings: ImageSettings, _log: Logger): ImageModel {
  return NO_IMAGE_MODEL;
}
