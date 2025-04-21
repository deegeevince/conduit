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
  for (const el of Object.values(elements)) {

    ctx.save()

    const opacity = el.opacity ?? 1
    if (opacity <= 0.01) {
      ctx.restore()
      continue  // 👈 properly skip rendering this element
    }
    ctx.globalAlpha = opacity

    if (el.type === 'image' && !el.img) {
      ctx.restore()
      continue
    }

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
        if (!el.text || el.text.trim() === '') {
          ctx.restore()
          return
        }
        ctx.font = `${el.size}px sans-serif`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        
        const textWidth = ctx.measureText(el.text).width
        const style = el.style || ''
      
        if (style.includes('highlight')) {
          ctx.save()
          ctx.globalAlpha = el.opacity ?? 1
          const color = style.split(':')[1] || '#ffffaa'
          ctx.fillStyle = color
          ctx.fillRect(-4, -4, textWidth + 8, el.size + 8)
          ctx.restore()
        }
        

        // Outline text before fillText
        if (style.includes('outline')) {
          ctx.save()
          ctx.globalAlpha = el.opacity ?? 1
          const colorMatch = style.match(/outline:#([0-9a-fA-F]{3,6})/)
          const outlineColor = colorMatch ? `#${colorMatch[1]}` : '#000000'
          ctx.strokeStyle = outlineColor
          ctx.lineWidth = 2
          ctx.strokeText(el.text, 0, 0)
          ctx.restore()
        }
      
        // Optional: halo (glow around text)
        if (style.includes('halo')) {
          ctx.save()
          ctx.globalAlpha = el.opacity ?? 1
          ctx.shadowColor = el.color
          ctx.shadowBlur = 12
          ctx.restore()
        } else {
          ctx.shadowBlur = 0
        }
      
        // Draw the actual text
        ctx.fillStyle = el.color
        ctx.fillText(el.text, 0, 0)
      
        // Underline
        if (style.includes('underline')) {
          ctx.save()
          ctx.globalAlpha = el.opacity ?? 1
          ctx.beginPath()
          ctx.moveTo(0, el.size * 1.1)
          ctx.lineTo(textWidth, el.size * 1.1)
          ctx.strokeStyle = el.color
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.restore()
        }
      
        // Strike-through
        if (style.includes('strike')) {
          ctx.save()
          ctx.globalAlpha = el.opacity ?? 1
          ctx.beginPath()
          ctx.moveTo(0, el.size / 2)
          ctx.lineTo(textWidth, el.size / 2)
          ctx.strokeStyle = el.color
          ctx.lineWidth = 2
          ctx.stroke()
          ctx.restore()
        }
      
        break
      }

      case 'image': {
        const img = el.img as HTMLImageElement
        const cw = canvas.width, ch = canvas.height
        let drawX = 0, drawY = 0

        if (el.align === 'left') {
          drawX = 20
        } else if (el.align === 'right') {
          drawX = cw - img.width - 20
        } else { // center
          drawX = (cw - img.width) / 2
        }
        drawY = (ch - img.height) / 2
        console.log('image?')
        ctx.drawImage(img, drawX, drawY, img.width, img.height)
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
  }
}
