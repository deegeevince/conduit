import { drawScene } from './components'
import gsap from 'gsap'

// 🔥 Global timeline
const timeline = gsap.timeline({ defaults: { onUpdate: drawScene }, paused: true })

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

export function animateTypewriter(el: any, interval: number) {
  const fullText = el.text
  el.text = ''
  el.opacity = 1 // ✅ Ensure text is visible before typing starts
  const typeTimeline = gsap.timeline({ onUpdate: drawScene })

  for (let i = 0; i < fullText.length; i++) {
    typeTimeline.call(() => {
      el.text += fullText[i]
    }, undefined, interval * i / 1000)
  }

  timeline.add(typeTimeline, '+=0')
}



// ✅ Optional: export the timeline for control (pause, resume, etc.)
export { timeline }
