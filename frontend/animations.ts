import { drawScene } from './components'

export function animateMove(el: any, targetX: number, targetY: number, duration: number) {
  const startTime = performance.now()
  const startX = el.x
  const startY = el.y

  function animate(time: number) {
    const elapsed = time - startTime
    const t = Math.min(elapsed / duration, 1)

    el.x = startX + (targetX - startX) * t
    el.y = startY + (targetY - startY) * t

    drawScene()

    if (t < 1) requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)
}

export function animateFade(el: any, targetOpacity: number, duration: number) {
  const startTime = performance.now()
  const startOpacity = el.opacity ?? 1

  function animate(time: number) {
    const elapsed = time - startTime
    const t = Math.min(elapsed / duration, 1)

    el.opacity = startOpacity + (targetOpacity - startOpacity) * t
    drawScene()

    if (t < 1) {
      requestAnimationFrame(animate)
    }
  }

  requestAnimationFrame(animate)
}

export function animateRotate(el: any, targetDegrees: number, duration: number) {
  const startTime = performance.now()
  const startRotation = el.rotation ?? 0
  const targetRotation = startRotation + targetDegrees

  function animate(time: number) {
    const elapsed = time - startTime
    const t = Math.min(elapsed / duration, 1)

    el.rotation = startRotation + (targetRotation - startRotation) * t
    drawScene()

    if (t < 1) requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)
}

export function animateScale(el: any, targetScale: number, duration: number) {
  const startTime = performance.now()
  const startScale = el.scale ?? 1
  targetScale = startScale * targetScale

  function animate(time: number) {
    const elapsed = time - startTime
    const t = Math.min(elapsed / duration, 1)

    el.scale = startScale + (targetScale - startScale) * t
    drawScene()

    if (t < 1) requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)
}

