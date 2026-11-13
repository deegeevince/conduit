import type { ImageModel } from '../domain/images';
import type { ImageSettings } from '../env';
import type { Logger } from '../log';
import { NO_IMAGE_MODEL } from './none';
import { createOpenAiImages } from './openai/openai-images';

/** The image model the environment chose. With IMAGE_MODEL unset this is the stand-in and no painting is ever asked for. */
export function createImageModel(settings: ImageSettings, log: Logger): ImageModel {
  if (settings.kind === 'none') return NO_IMAGE_MODEL;
  return createOpenAiImages({ log, apiKey: settings.apiKey, model: settings.model, quality: settings.quality, timeoutMs: settings.timeoutMs, baseUrl: settings.baseUrl, fetch });
}
