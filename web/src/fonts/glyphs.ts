// Plain data and nothing else: `scripts/build-fonts.mjs` reads this file to know which advances to tabulate, so it must stay importable without a bundler.

/**
 * Every character that all shipped faces contain. Nothing outside this set may
 * reach a renderer: the WebGL text renderer answers a missing glyph by
 * downloading a fallback font from a public CDN, which this app must never do.
 */
export const GLYPHS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  '¡¢£¥§¨©ª«®¯°´¶·¸º»¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ' +
  '…—–‘’“”•€‹›„‚';
