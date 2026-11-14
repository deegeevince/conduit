// A picture of the page as it stands, for the stills (the catalogue's thumbnail, the critic's look). A sandboxed page cannot be photographed
// from outside, so it draws itself: the document is copied, written out as an SVG with the page in a foreignObject, and drawn to a canvas.
// The server's own headless Chrome is the better witness (PLAN-v3-core 2.6); this is the self-portrait where there is none, and is marked so.

export function still(width: number, height: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const scale = Math.min(1, 960 / Math.max(1, width));
      const copy = document.documentElement.cloneNode(true);
      if (!(copy instanceof Element)) return resolve(null);
      copy.querySelectorAll('script').forEach((el) => el.remove());
      const live = document.querySelectorAll('input');
      const mirror = copy.querySelectorAll('input');
      live.forEach((el, i) => mirror[i]?.setAttribute('value', el.value));
      const xml = new XMLSerializer().serializeToString(copy);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
      const picture = new Image();
      picture.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const context = canvas.getContext('2d');
        if (context === null) return resolve(null);
        context.fillStyle = getComputedStyle(document.body).backgroundColor;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(picture, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      };
      picture.onerror = () => resolve(null);
      picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      resolve(null);
    }
  });
}
