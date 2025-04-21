import { resizeCanvas, drawScene } from './components'
import { sendPrompt } from './stream'

window.addEventListener('resize', resizeCanvas)
resizeCanvas()

document.getElementById('runButton')?.addEventListener('click', () => {
  const input = document.getElementById('promptInput') as HTMLInputElement
  if (input.value.trim()) sendPrompt(input.value.trim())
})

document.getElementById('promptInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const input = e.target as HTMLInputElement
    if (input.value.trim()) sendPrompt(input.value.trim())
  }
})

// 3. Start the continuous render loop
function renderLoop() {
  drawScene()
  requestAnimationFrame(renderLoop)
}
renderLoop()

