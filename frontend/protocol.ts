import { elements, drawScene, state } from './components'
import { animateMove, animateFade, animateRotate, animateScale, timeline, animateTypewriter } from './animations'

export function handleCommand(command: string) {
  const parts = command.split(':')
  const cmd = parts[0]

  switch (cmd) {
    case 'B': { // Background color
      const color = parts[1]

      let colorProxy = { color: state.backgroundColor }

      timeline.to(colorProxy, {
        color: color,
        duration: 0.5,
        onUpdate: () => {
          state.backgroundColor = colorProxy.color
          drawScene()
        },
        ease: 'none'
      })
      break
    }

    case 'C': { // Circle
      const [id, position, radius, color] = parts.slice(1)
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      elements[id] = { type: 'circle', x, y, radius: Number(radius), color, rotation: 0, scale: 1, opacity: 1 }
      timeline.call(() => drawScene())
      break
    }

    case 'F': { // Fade out
      const [id, duration] = parts.slice(1)
      const el = elements[id]
      if (el) animateFade(el, 0, Number(duration))
      break
    }

    case 'A': {
      const [id, animType, ...params] = parts.slice(1)
      animateElement(id, animType, params)
      break
    }
    
    case 'L': { // Line
      const [id, start, end, thickness, color] = parts.slice(1)
      const [x1, y1] = start.replace(/[()]/g, '').split(',').map(Number)
      const [x2, y2] = end.replace(/[()]/g, '').split(',').map(Number)
      elements[id] = { type: 'line', x: x1, y: y1, x1, y1, x2, y2, thickness: Number(thickness), color, opacity: 1 }
      timeline.call(() => drawScene())
      break
    }

    case 'M': { // Move
      const [id, position, duration] = parts.slice(1)
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      const el = elements[id]
      if (el) animateMove(el, x, y, Number(duration))
      break
    }

    case 'R': { // Rotate
      const [id, degrees, duration] = parts.slice(1)
      const el = elements[id]
      if (el) animateRotate(el, Number(degrees), Number(duration))
      break
    }

    case 'W': { // Wait
      const [duration] = parts.slice(1)
      timeline.to({}, { duration: Number(duration) / 1000 })
      break
    }

    case 'X': { // Remove with animation
      const [id] = parts.slice(1)
      const el = elements[id]
      if (!el) break
    
      timeline.to(el, {
        opacity: 0,
        duration: 0.5,
        onUpdate: drawScene,
        onComplete: () => {
          delete elements[id]
          drawScene() // Final cleanup
        }
      })
      break
    }

    case 'S': { // Scale
      const [id, scale, duration] = parts.slice(1)
      const el = elements[id]
      if (el) animateScale(el, Number(scale), Number(duration))
      break
    }

    case 'T': {
      const [id, rawText, position, size, color] = parts.slice(1)
      const text = rawText.replace(/"/g, '')
      const [rawX, rawY] = position.replace(/[()]/g, '').split(',')
    
      // Normalize center positioning
      const x = rawX.trim() === 'center' ? window.innerWidth / 2 : Number(rawX)
      const y = rawY.trim() === 'center' ? window.innerHeight / 2 : Number(rawY)
    
      elements[id] = {
        type: 'text',
        text,
        x,
        y,
        size: Number(size),
        color,
        rotation: 0,
        scale: 1,
        opacity: 0
      }
    
      // timeline.call(() => drawScene())
      break
    }
    
    
    case 'PT': { // Point
      const [id, position, size, color] = parts.slice(1)
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      elements[id] = { type: 'point', x, y, size: Number(size), color, opacity: 1 }
      // timeline.call(() => drawScene())

      break
    }

    case 'P': { // Polygon
      const [id, ...rest] = parts.slice(1)
      const color = rest.pop()!
      const points = rest.map(pt => pt.replace(/[()]/g, '').split(',').map(Number))
      elements[id] = { type: 'polygon', points, color, rotation: 0, scale: 1, opacity: 1, x: 0, y: 0 }
      // timeline.call(() => drawScene())

      break
    }

    case 'N': { // Duplicate
      const [sourceId, newId] = parts.slice(1)
      const source = elements[sourceId]
      if (source) {
        elements[newId] = { ...source }
        // timeline.call(() => drawScene())

      }
      break
    }

    default:
      console.warn('Unknown command:', command)
  }
}

function animateElement(id: string, animType: string, params: string[]) {
  const el = elements[id]
  if (!el) return

  const animate = () => drawScene()
  switch (animType) {
    case 'fadeIn': {
      const duration = Number(params[0].split('=')[1]) / 1000
      timeline.to(el, { opacity: 1, duration, onUpdate: animate })
      break
    }
    case 'fadeOut': {
      const duration = Number(params[0].split('=')[1]) / 1000
      timeline.to(el, { opacity: 0, duration, onUpdate: animate })
      break
    }
    case 'pulse': {
      const scale = Number(params[0].split('=')[1])
      const duration = Number(params[1].split('=')[1]) / 1000
      const repeat = Number(params[2].split('=')[1])
      timeline.to(el, {
        opacity: 1,
        scale,
        duration,
        repeat,
        yoyo: true,
        onUpdate: animate
      })
      break
    }
    case 'slideIn': {
      const from = params[0].split('=')[1]
      const distance = Number(params[1].split('=')[1])
      const duration = Number(params[2].split('=')[1]) / 1000
      const originalX = el.x
      const originalY = el.y
      if (from === 'left') el.x -= distance
      if (from === 'right') el.x += distance
      if (from === 'top') el.y -= distance
      if (from === 'bottom') el.y += distance
      timeline.to(el, {
        opacity: 1,
        x: originalX,
        y: originalY,
        duration,
        onUpdate: animate
      })
      break
    }
    case 'scaleTo': {
      const scale = Number(params[0].split('=')[1])
      const duration = Number(params[1].split('=')[1]) / 1000
      timeline.to(el, { opacity: 1, scale, duration, onUpdate: animate })
      break
    }
    case 'rotateTo': {
      const degrees = Number(params[0].split('=')[1])
      const duration = Number(params[1].split('=')[1]) / 1000
      timeline.to(el, { opacity: 1, rotation: degrees, duration, onUpdate: animate })
      break
    }
    case 'type': {
      const interval = Number(params[0].split('=')[1])
      animateTypewriter(el, interval)
      break
    }
  }
}