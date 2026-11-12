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

      // Create and set up image element
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.style.position = 'absolute'
      img.style.left = '-9999px'  // Initially off-screen
      img.style.top = '-9999px'
      img.style.visibility = 'hidden'
      document.body.appendChild(img)

      // Add to elements immediately
      elements[id] = {
        type: 'image',
        img,
        align,
        opacity: 0,
        x: -9999,
        y: -9999
      }

      const GIPHY_API_KEY='YOUR_GIPHY_API_KEY'
      // urlPromise = Promise.resolve("http://localhost:3000/images/mindblown.gif")
      // Fetch image URL based on source
      if (source === 'giphy') {
        fetch(`https://api.giphy.com/v1/gifs/random?api_key=${GIPHY_API_KEY}&tag=${encodeURIComponent(tag)}`)
          .then(r => r.json())
          .then(json => {
            img.src = json.data.images.fixed_height.url
          })
          .catch(err => {
            console.error('Giphy API error:', err)
            img.src = '/images/mindblown.gif' // Fallback if API fails
          })
      } else {
        img.src = `https://source.unsplash.com/800x600/?${encodeURIComponent(tag)}`
      }

      // Handle image load
      img.onload = () => {
        const el = elements[id]
        const padding = 20
        const cw = window.innerWidth
        const ch = window.innerHeight

        // Calculate final position based on alignment
        switch(align) {
          case 'left':
            el.x = padding
            el.y = (ch - img.naturalHeight) / 2
            break
          case 'right':
            el.x = cw - img.naturalWidth - padding
            el.y = (ch - img.naturalHeight) / 2
            break
          case 'top':
            el.x = (cw - img.naturalWidth) / 2
            el.y = padding
            break
          case 'bottom':
            el.x = (cw - img.naturalWidth) / 2
            el.y = ch - img.naturalHeight - padding
            break
          default: // center
            el.x = (cw - img.naturalWidth) / 2
            el.y = (ch - img.naturalHeight) / 2
        }

        // Fade in using our existing animation system
        // animateElement(id, 'fadeIn', ['duration=800', 'immediateRender=false'])
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

  // parse absolute times
  const start = Number(params.find(p => p.startsWith('start='))!.split('=')[1])
  const end   = Number(params.find(p => p.startsWith('end='))!.split('=')[1])
  const duration = end - start
  console.log('animateelement', start, duration)

  switch (animType) {
    case 'fadeIn':
      timeline.to(el,
        { opacity: 1, immediateRender: false, onUpdate: animate, duration },
        start
      )
      break

    case 'fadeOut':
      timeline.to(el,
        { opacity: 0, immediateRender: false, onUpdate: animate, duration },
        start
      )
      break

    case 'slideIn': {
      const from     = params.find(p => p.startsWith('from='))!.split('=')[1]
      const distanceParam = params.find(p => p.startsWith('distance='))?.split('=')[1]
      const distance = !distanceParam || isNaN(Number(distanceParam)) ? 30 : Number(distanceParam)
      const tx = el.x, ty = el.y
      const fromVars: any = { opacity: 0 }
      if (from === 'left')   fromVars.x = tx - distance
      if (from === 'right')  fromVars.x = tx + distance
      if (from === 'top')    fromVars.y = ty - distance
      if (from === 'bottom') fromVars.y = ty + distance

      timeline.fromTo(el,
        fromVars,
        { x: tx, y: ty, opacity: 1, immediateRender: false, onUpdate: animate, duration },
        start
      )
      break
    }

    case 'pulse': {
      const scale  = Number(params.find(p => p.startsWith('scale='))!.split('=')[1])
      const repeat = Number(params.find(p => p.startsWith('repeat='))!.split('=')[1])
      timeline.to(el,
        { scale, repeat, yoyo: true, immediateRender: false, onUpdate: animate, duration },
        start
      )
      break
    }

    case 'scaleTo': {
      const scaleParam = params.find(p => p.startsWith('scale='))?.split('=')[1]
      const scale = !scaleParam || isNaN(Number(scaleParam)) ? 1.1 : Number(scaleParam)
      timeline.to(el,
        { scale, immediateRender: false, onUpdate: animate, duration },
        start
      )
      break
    }

    case 'rotateTo': {
      const degreesParam = params.find(p => p.startsWith('degrees='))?.split('=')[1]
      const degrees = !degreesParam || isNaN(Number(degreesParam)) ? 50 : Number(degreesParam)
      timeline.to(el,
        { rotation: degrees, immediateRender: false, onUpdate: animate, duration },
        start
      )
      break
    }

    case 'type': {
      // parse absolute start/end and interval
      // const interval = Number(params.find(p => p.startsWith('interval='))?.split('=')[1] || '20') / 1000
      
      // prepare the element
      const fullText = el.text
      el.text        = ''
      // el.opacity     = 1  // make sure it’s visible
      // console.log('fullText', fullText)
      console.log('fulltext length', fullText.length, 'duration', duration)
      const interval = duration / fullText.length;
      console.log(interval)

      // schedule each character at absolute times
      for (let i = 0; i < fullText.length; i++) {
        const t = start + i * interval
        console.log(start, i, interval, t)
        timeline.call(
          () => { 
            el.text += fullText[i]; 
            console.log('scheduling', el.text, t)
            drawScene() 
          },
          undefined,
          t
        )
      }
    
      break
    }
  }
}

