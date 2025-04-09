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

// Add more animations here (fade, scale, rotate...)!
