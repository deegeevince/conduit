import express from 'express'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import compression from 'compression'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(compression()) // Enable compression globally

// Utility to safely parse incoming chunks
function safeJsonParse(input: string) {
  try {
    return JSON.parse(input)
  } catch (e) {
    return null
  }
}

app.use(express.json())

// Utility to clean incoming token fragments
function cleanChunk(chunk: string) {
  return chunk.replace(/\s+/g, '') // remove all whitespace
}

const commandQueue: string[] = []
let queueStreaming = false

function startQueueStream(res: express.Response) {
  if (queueStreaming) return // Prevent multiple loops
  queueStreaming = true

  function tick() {
    if (commandQueue.length > 0) {
      const command = commandQueue.shift()
      if (command) {
        console.log('🚀 Sending command from queue:', command)
        res.write(`data: ${command}\n\n`)
        res.flush?.()
      }
    }

    setTimeout(tick, 0) // Adjust interval here (lower = faster, higher = slower)
  }

  tick()
}


// Start stream endpoint
app.post('/stream', (req, res, next) => {
  commandQueue.length = 0
  queueStreaming = false
  res.setHeader('Content-Encoding', 'identity')
  next()
}, async (_req, res) => {

  const { prompt } = _req.body

  if (!prompt) {
    res.status(400).send('Missing prompt')
    return
  }
  

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // nginx
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.flushHeaders?.() // Explicitly flush headers once set
  
  console.log('🟢 Starting OpenAI stream')
  startQueueStream(res)

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo',
        stream: true,
        messages: [
          {
            role: 'system',
            content: `
You are the visual conductor of a living canvas.

Your goal is to create an evolving, dynamic visual performance. Imagine you are composing a dance of shapes, lines, and points across the space — full of motion, rhythm, and progression.
Maintain deliberate pacing between commands. Imagine you are conducting a slow, elegant performance. Introduce pauses and spacing between actions, to let animations complete before introducing new commands.

You are using the Series protocol to instruct the canvas:
- B:color — Set the background color.
- C:id:(x,y):radius:color — Draw a circle.
- T:"text":(x,y):size:color — Draw text.
- M:id:(x,y):duration — Move an element smoothly over time.
- F:id:duration — Fade out an element over time.
- S:id:scale:duration — Scale an element.
- R:id:degrees:duration — Rotate an element.
- L:id:(x1,y1):(x2,y2):thickness:color — Draw a line between two points.
- R:id:(x,y):width:height:color — Draw a rectangle.
- PT:id:(x,y):size:color — Draw a point.
- P:id:(x1,y1):(x2,y2)...:color — Draw a polygon.
- W:duration — Wait/pause before next command.
- X:id — Remove an element.
- N:id:newId — Duplicate an element.

Guidelines:
- **Think like a composer**: build visual scenes that feel alive and evolving over time.
- Use movement to create flow. Shapes can drift, orbit, pulse, or connect.
- Build relationships: connect points with lines, arrange shapes into patterns.
- Introduce variety: combine circles, lines, points, and polygons to create compositions.
- Work in layers: foreground, midground, background. Animate each at different tempos.
- Vary your pacing: use pauses and bursts of activity to build rhythm.
- Avoid repetition: prefer progression and evolution of the scene.
- You may reuse elements, but give them new purpose through motion or transformation.
- Start by establishing a scene with 10–15 varied elements.
- Then, continuously evolve the scene by adding, moving, and transforming elements.
- Avoid setting the background repeatedly unless the scene demands a shift.
- Avoid wrapping commands in code blocks or quotes — output raw protocol commands only.
- Do not explain or narrate — only output commands.
- Give animation duration in milliseconds.

Visual Design Principles:
- Always maintain strong contrast between background and foreground elements.
- If the background is dark, prefer bright or neon foreground colors.
- If the background is light, prefer dark or saturated foreground colors.
- Use complementary or contrasting color schemes to make elements stand out.
- Avoid using the same color for background and foreground elements.
- Introduce variation in element colors to enhance visual interest.

Recommended Color Palettes:
- Dark theme: Background: #000000, Foreground: #00FFFF, #FF00FF, #FFFF00
- Light theme: Background: #FFFFFF, Foreground: #333333, #FF6347, #1E90FF
- Neon: Background: #000000, Foreground: bright saturated colors (#39FF14, #FF073A, #0FF0FC)


Tone:
- Aim for elegant, evolving visuals.
- Favor smooth transitions and progressive complexity.
- Use pauses for dramatic effect, then introduce new movement or forms.

Begin composing your visual performance now.
`
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    })

    if (!response.ok || !response.body) {
      const errorText = await response.text()
      console.error('OpenAI API error:', errorText)
      res.write(`data: ERROR\n\n`)
      res.end()
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let commandBuffer = ''

    response.body.on('data', (chunk: Buffer) => {
      const payload = decoder.decode(chunk)
      buffer += payload

      // Process complete SSE events (delimited by double newline)
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        if (event.startsWith('data:')) {
          const data = event.replace(/^data: /, '')
          if (data === '[DONE]') {
            // Flush any remaining commands in the buffer
            if (commandBuffer.trim().length > 0) {
              commandBuffer.trim().split('\n').forEach(line => {
                const trimmed = line.trim()
                if (trimmed.length > 0) {
                  console.log('✅ Flushing final command:', trimmed)
                  commandQueue.push(line)

                }
              })
            }
          
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          
          

          const parsed = safeJsonParse(data)
          const content = parsed?.choices?.[0]?.delta?.content

          if (content) {
            // console.log('⬇️ Incoming fragment:', JSON.stringify(content))

            commandBuffer += content

            let newlineIndex
            while ((newlineIndex = commandBuffer.indexOf('\n')) >= 0) {
              const line = commandBuffer.slice(0, newlineIndex).trim()
              commandBuffer = commandBuffer.slice(newlineIndex + 1)

              if (line.length > 0) {
                // console.log('✅ Command detected:', line)
                commandQueue.push(line)

              }
            }
          }
        }
      }

    })

    response.body.on('end', () => {
      console.log('🔴 Stream ended')
      
      // Flush any remaining commands in the buffer
      if (commandBuffer.trim().length > 0) {
        commandBuffer.trim().split('\n').forEach(line => {
          const trimmed = line.trim()
          if (trimmed.length > 0) {
            console.log('✅ Flushing final command:', trimmed)
            commandQueue.push(trimmed)
          }
        })
      }
      
      // Wait for queue to be processed before ending
      const checkQueue = setInterval(() => {
        if (commandQueue.length === 0) {
          clearInterval(checkQueue)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 100)
    })
  } catch (error) {
    console.error('🔥 Streaming error:', error)
    res.write(`data: ERROR\n\n`)
    res.end()
  }
})



app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}/stream`)
})
console.log(path.join(__dirname, '../../public'))
app.use(express.static(path.join(__dirname, '../../public')))

