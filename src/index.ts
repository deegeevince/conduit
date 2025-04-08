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

// Utility to clean incoming token fragments
function cleanChunk(chunk: string) {
  return chunk.replace(/\s+/g, '') // remove all whitespace
}

// Start stream endpoint
app.get('/stream', (req, res, next) => {
  res.setHeader('Content-Encoding', 'identity')
  next()
}, async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // nginx
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.flushHeaders?.() // Explicitly flush headers once set
  
  console.log('🟢 Starting OpenAI stream')

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
You are the visual conductor of a canvas.

Your goal is to continuously evolve and expand the scene using orchestration commands.

Rules:
- Avoid repeating the same commands unnecessarily.
- Introduce new visual elements progressively over time.
- Change positions, colors, or sizes to create visual interest.
- Move existing elements smoothly.
- You can add new elements at any time.
- Avoid re-setting the background color unless it changes.
- Only output orchestration commands, wrapped in triple backtick code blocks.

Available commands:
- \`\`\`C:elementId:(x,y):radius:color\`\`\` to draw a circle.
- \`\`\`T:"text":(x,y):size:color\`\`\` to draw text.
- \`\`\`M:elementId:(x,y):duration\`\`\` to move an element.
- \`\`\`B:color\`\`\` to set the background color.

Start by creating 10 elements in different positions and colors.
Then, slowly move them, change their colors, and introduce new elements every few commands.

Do not explain or narrate. Only stream valid commands continuously.

`
          },
          {
            role: 'user',
            content: 'Begin orchestration now.'
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
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }

          const parsed = safeJsonParse(data)
          const content = parsed?.choices?.[0]?.delta?.content

          if (content) {
            console.log('⬇️ Incoming fragment:', JSON.stringify(content))

            commandBuffer += content

            let newlineIndex
            while ((newlineIndex = commandBuffer.indexOf('\n')) >= 0) {
              const line = commandBuffer.slice(0, newlineIndex).trim()
              commandBuffer = commandBuffer.slice(newlineIndex + 1)

              if (line.length > 0) {
                console.log('✅ Command detected:', line)
                res.write(`data: ${line}\n\n`)
                res.flush?.()
              }
            }
          }
        }
      }
    })

    response.body.on('end', () => {
      console.log('🔴 Stream ended')
      res.write('data: [DONE]\n\n')
      res.end()
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

app.use(express.static(path.join(__dirname, '../public')))

