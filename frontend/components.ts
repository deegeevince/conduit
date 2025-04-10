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
  
  ctx.fillStyle = state.backgroundColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  Object.values(elements).forEach(el => {
    ctx.save()
    ctx.globalAlpha = el.opacity ?? 1
    ctx.translate(el.x, el.y)
    ctx.rotate((el.rotation ?? 0) * Math.PI / 180)
    ctx.scale(el.scale ?? 1, el.scale ?? 1)

    if (el.type === 'circle') {
      ctx.beginPath()
      ctx.arc(0, 0, el.radius, 0, Math.PI * 2)
      ctx.fillStyle = el.color
      ctx.fill()
    } else if (el.type === 'text') {
      ctx.fillStyle = el.color
      ctx.font = `${el.size}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(el.text, 0, 0)
    }

    // Add more draw types (line, rect, polygon, etc.) here!

    ctx.restore()
  })
}
