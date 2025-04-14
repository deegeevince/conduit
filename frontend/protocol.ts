import { elements, drawScene, state } from './components'
import { animateMove, animateFade, animateRotate, animateScale, timeline } from './animations'

export function handleCommand(command: string) {
  const parts = command.split(':')
  const cmd = parts[0]

  switch (cmd) {
    case 'B': { // Background color
      const color = parts[1]
      state.backgroundColor = color
      timeline.call(() => drawScene())
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

    case 'T': { // Text
      console.log(parts);
      const [text, position, size, color] = parts.slice(1)
      const cleanText = text.replace(/["]/g, '')
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      const id = `text${Object.keys(elements).length}`
      elements[id] = { type: 'text', text: cleanText, x, y, size: Number(size), color, rotation: 0, scale: 1, opacity: 1 }
      console.log(elements[id])
      timeline.call(() => drawScene())
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

    case 'X': { // Remove
      const [id] = parts.slice(1)
      // delete elements[id]
      // drawScene()
      break
    }

    case 'S': { // Scale
      const [id, scale, duration] = parts.slice(1)
      const el = elements[id]
      if (el) animateScale(el, Number(scale), Number(duration))
      break
    }

    case 'PT': { // Point
      const [id, position, size, color] = parts.slice(1)
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      elements[id] = { type: 'point', x, y, size: Number(size), color, opacity: 1 }
      timeline.call(() => drawScene())

      break
    }

    case 'P': { // Polygon
      const [id, ...rest] = parts.slice(1)
      const color = rest.pop()!
      const points = rest.map(pt => pt.replace(/[()]/g, '').split(',').map(Number))
      elements[id] = { type: 'polygon', points, color, rotation: 0, scale: 1, opacity: 1, x: 0, y: 0 }
      timeline.call(() => drawScene())

      break
    }

    case 'N': { // Duplicate
      const [sourceId, newId] = parts.slice(1)
      const source = elements[sourceId]
      if (source) {
        elements[newId] = { ...source }
        timeline.call(() => drawScene())

      }
      break
    }

    default:
      console.warn('Unknown command:', command)
  }
}
