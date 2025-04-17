import { handleCommand } from './protocol'
import { clearElements } from './components'
import { timeline } from './animations'

export function sendPrompt(prompt: string) {
  clearElements()
  console.log('Sending prompt:', prompt)
  fetch('/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  }).then(response => {
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    function read() {
      reader?.read().then(({ done, value }) => {
        if (done) return
        const chunk = decoder.decode(value)
        chunk.trim().split('\n').forEach(line => {
          if (line.startsWith('data: ')) {
            const command = line.replace(/^data: /, '').trim()
            console.log(command)
            if (command !== '[DONE]') {
              handleCommand(command)
            } else {
              timeline.play();
            }
          }
        })
        read()
      })
    }

    read()
  }).catch(error => console.error('Stream error:', error))
}
