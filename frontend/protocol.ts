import { elements, drawScene, state } from './components'
import { animateMove } from './animations'

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

    case 'T': {
      const [text, position, size, color] = parts.slice(1)
      const cleanText = text.replace(/["]/g, '')
      const [x, y] = position.replace(/[()]/g, '').split(',').map(Number)
      const id = `text${Object.keys(elements).length}`
      elements[id] = { type: 'text', text: cleanText, x, y, size: Number(size), color, rotation: 0, scale: 1, opacity: 1 }
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

    // Add more commands as needed!

    default:
      console.warn('Unknown command:', command)
  }
}
