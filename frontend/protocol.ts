import { elements, drawScene, state } from './components'
import { animateMove, animateFade, animateRotate, animateScale, timeline, animateTypewriter } from './animations'
import gsap from 'gsap'


export function handleCommand(command: string) {
  const parts = command.split(':')
  const cmd = parts[0]

  switch (cmd) {
    case 'B': {
      const targetColor = gsap.utils.splitColor(parts[1]);
    
      timeline.add(() => {
        const current = gsap.utils.splitColor(state.backgroundColor);
    
        const colorProxy = {
          r: current[0],
          g: current[1],
          b: current[2]
        };
    
        gsap.to(colorProxy, {
          r: targetColor[0],
          g: targetColor[1],
          b: targetColor[2],
          duration: 0.5,
          ease: 'none',
          onUpdate: () => {
            state.backgroundColor = `rgb(${Math.round(colorProxy.r)}, ${Math.round(colorProxy.g)}, ${Math.round(colorProxy.b)})`;
            drawScene();
          }
        });
      });
    
      break;
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
      timeline.to({}, { immediateRender: false, duration: Number(duration) / 1000 })
      break
    }

    case 'X': { // Remove with animation
      const [id] = parts.slice(1)
      const el = elements[id]
      if (!el) break
    
      timeline.to(el, {
        immediateRender: false, 
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
      const [id, rawText, position, size, color, ...rest] = parts.slice(1)
      const text = rawText.replace(/"/g, '')
      const [rawX, rawY] = position.replace(/[()]/g, '').split(',')
    
      const x = rawX.trim() === 'center' ? window.innerWidth / 2 : Number(rawX)
      const y = rawY.trim() === 'center' ? window.innerHeight / 2 : Number(rawY)
    
      const stylePart = rest.find(p => p.startsWith('style='))
      const style = stylePart ? stylePart.replace('style=', '') : undefined
    
      elements[id] = {
        type: 'text',
        text,
        x,
        y,
        size: Number(size),
        color,
        rotation: 0,
        scale: 1,
        opacity: 0,
        style
      }
    
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

    case 'RIMG': {
      // RIMG:id:source=giphy|unsplash:tag="...":align=left|right|top|bottom|center
      const [id, sourcePart, tagPart, alignPart] = parts.slice(1)
      const source = sourcePart.split('=')[1]
      const tag    = tagPart.split('=')[1].replace(/^"|"$/g, '')
      const align  = alignPart.split('=')[1]

      // placeholder element
      elements[id] = {
        type: 'image',
        img: null as HTMLImageElement | null,
        align,
        opacity: 0,
        x: 0,
        y: 0
      }
       // fetch a random image URL
       let urlPromise: Promise<string>
       const GIPHY_API_KEY = 'YOUR_GIPHY_API_KEY'
              
       if (source === 'giphy') {
         urlPromise = fetch(
           `https://api.giphy.com/v1/gifs/random?api_key=${GIPHY_API_KEY}&tag=${encodeURIComponent(tag)}`
         )
         .then(r => r.json())
         .then(json => json.data.images.fixed_height.url)
       } else {
         urlPromise = Promise.resolve(
           `https://source.unsplash.com/800x600/?${encodeURIComponent(tag)}`
         )
       }
 
       urlPromise.then(url => {
         const img = new Image()
         img.src = url
         img.onload = () => {
           const el = elements[id] as any
           el.img = img
           el.width  = img.naturalWidth
           el.height = img.naturalHeight
           // fade in once loaded
           animateElement(id, 'fadeIn', ['duration=800', 'immediateRender=false'])
         }
       })
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
      timeline.to(el, { opacity: 1, duration, immediateRender: false, onUpdate: animate })
      break
    }
    case 'fadeOut': {
      const duration = Number(params[0].split('=')[1]) / 1000
      timeline.to(el, { opacity: 0, duration, immediateRender: false, onUpdate: animate })
      break
    }
    case 'pulse': {
      const scale = Number(params[0].split('=')[1])
      const duration = Number(params[1].split('=')[1]) / 1000
      const repeat = Number(params[2].split('=')[1])
      timeline.to(el, {
        immediateRender: false,
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
        immediateRender: false,
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
      timeline.to(el, { opacity: 1, scale, duration, immediateRender: false, onUpdate: animate })
      break
    }
    case 'rotateTo': {
      const degrees = Number(params[0].split('=')[1])
      const duration = Number(params[1].split('=')[1]) / 1000
      timeline.to(el, { opacity: 1, rotation: degrees, duration, immediateRender: false, onUpdate: animate })
      break
    }
    case 'type': {
      const interval = Number(params[0].split('=')[1])
      animateTypewriter(el, interval)
      break
    }
  }
}