import { drawScene } from './components'
import gsap from 'gsap'

// 🔥 Global timeline
const timeline = gsap.timeline({ defaults: { onUpdate: drawScene } })

export function animateMove(el: any, targetX: number, targetY: number, duration: number) {
  timeline.to(el, {
    x: targetX,
    y: targetY,
    duration: duration / 1000
  })
}

export function animateFade(el: any, targetOpacity: number, duration: number) {
  timeline.to(el, {
    opacity: targetOpacity,
    duration: duration / 1000
  })
}

export function animateScale(el: any, targetScale: number, duration: number) {
  timeline.to(el, {
    scale: targetScale,
    duration: duration / 1000
  })
}

export function animateRotate(el: any, targetDegrees: number, duration: number) {
  timeline.to(el, {
    rotation: targetDegrees,
    duration: duration / 1000
  })
}

// ✅ Optional: export the timeline for control (pause, resume, etc.)
export { timeline }
