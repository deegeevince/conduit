export interface Element {
  type: string
  x: number
  y: number
  rotation?: number
  scale?: number
  opacity?: number
  [key: string]: any
}

export const elements: Record<string, Element> = {}

// components.ts
export const state = {
  backgroundColor: '#000000'
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement
export const ctx = canvas.getContext('2d')!

export function resizeCanvas() {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
}

export function clearElements() {
  Object.keys(elements).forEach(key => delete elements[key])
  state.backgroundColor = '#ffffff'
  drawScene()
}

export function drawScene() {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  
  // Background
  ctx.fillStyle = state.backgroundColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw all elements
  Object.values(elements).forEach(el => {
    ctx.save()

    ctx.globalAlpha = el.opacity ?? 1
    ctx.translate(el.x, el.y)
    ctx.rotate((el.rotation ?? 0) * Math.PI / 180)
    ctx.scale(el.scale ?? 1, el.scale ?? 1)

    switch (el.type) {
      case 'circle': {
        ctx.beginPath()
        ctx.arc(0, 0, el.radius, 0, Math.PI * 2)
        ctx.fillStyle = el.color
        ctx.fill()
        break
      }

      case 'text': {
        ctx.fillStyle = el.color
        ctx.font = `${el.size}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(el.text, 0, 0)
        break
      }

      case 'line': {
        ctx.beginPath()
        ctx.moveTo(el.x1 - el.x, el.y1 - el.y)
        ctx.lineTo(el.x2 - el.x, el.y2 - el.y)
        ctx.strokeStyle = el.color
        ctx.lineWidth = el.thickness
        ctx.stroke()
        break
      }

      case 'rect': {
        ctx.fillStyle = el.color
        ctx.fillRect(0, 0, el.width, el.height)
        break
      }

      case 'point': {
        ctx.beginPath()
        ctx.arc(0, 0, el.size, 0, Math.PI * 2)
        ctx.fillStyle = el.color
        ctx.fill()
        break
      }

      case 'polygon': {
        const points = el.points as number[][]
        if (points.length > 1) {
          ctx.beginPath()
          points.forEach(([px, py], index) => {
            const relativeX = px - el.x
            const relativeY = py - el.y
            if (index === 0) {
              ctx.moveTo(relativeX, relativeY)
            } else {
              ctx.lineTo(relativeX, relativeY)
            }
          })
          ctx.closePath()
          ctx.fillStyle = el.color
          ctx.fill()
        }
        break
      }

      default: {
        console.warn('Unknown element type in drawScene:', el.type)
        break
      }
    }

    ctx.restore()
  })
}
