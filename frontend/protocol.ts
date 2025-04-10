import { elements, drawScene, state } from './components'
import { animateMove, animateFade, animateRotate } from './animations'

export function handleCommand(command: string) {
  const parts = command.split(':')
  const cmd = parts[0]

  switch (cmd) {
    case 'B': {
      const color = parts[1]
      state.backgroundColor = color
      drawScene()
      break
    }

    case 'C': {
      const [id, position, radius, color] = parts.slice(1)
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      elements[id] = { type: 'circle', x, y, radius: Number(radius), color, rotation: 0, scale: 1, opacity: 1 }
      drawScene()
      break
    }

    case 'F': { // Fade out
      const [id, duration] = parts.slice(1)
      const el = elements[id]
      if (el) animateFade(el, 0, Number(duration))
      break
    }
    

    case 'T': {
      const [text, position, size, color] = parts.slice(1)
      const cleanText = text.replace(/["]/g, '')
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      const id = `text${Object.keys(elements).length}`
      elements[id] = { type: 'text', text: cleanText, x, y, size: Number(size), color, rotation: 0, scale: 1, opacity: 1 }
      drawScene()
      break
    }

    case 'L': { // Line
      const [id, start, end, thickness, color] = parts.slice(1)
      const [x1, y1] = start.replace(/[()]/g, '').split(',').map(Number)
      const [x2, y2] = end.replace(/[()]/g, '').split(',').map(Number)
    
      elements[id] = {
        type: 'line',
        x: x1,
        y: y1,
        x1,
        y1,
        x2,
        y2,
        thickness: Number(thickness),
        color,
        opacity: 1
      }
    
      drawScene()
      break
    }    

    case 'M': {
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

    case 'W': { // Wait / delay
      const [duration] = parts.slice(1)
      setTimeout(() => {
        // Optionally, redraw after wait
        drawScene()
      }, Number(duration))
      break
    }

    case 'X': { // Remove element
      const [id] = parts.slice(1)
      delete elements[id]
      drawScene()
      break
    }
    
    

    default:
      console.warn('Unknown command:', command)
  }
}
