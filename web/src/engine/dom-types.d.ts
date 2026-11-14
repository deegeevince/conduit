// The contracts name a few DOM types in signatures the engine never calls. Declared opaque here so that a name can be mentioned
// but nothing can be done with it: any property access, and any DOM value (document, performance, requestAnimationFrame), still fails the build.
declare type Blob = object;
declare type HTMLElement = object;
declare type HTMLCanvasElement = object;
declare type CanvasImageSource = object;
