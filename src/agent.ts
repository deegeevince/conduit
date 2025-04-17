import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Agent - Converts SceneDirector output into Series protocol instructions
 * for visual animation on the canvas.
 */
export class Agent {
  private apiKey: string;
  private model: string = 'gpt-4-turbo';

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }
  }

  /**
   * Convert a SceneDirector output into Series protocol instructions
   * @param scenePlan The output from SceneDirector.processScene
   * @returns A string containing Series protocol commands
   */
  async convertToSeriesProtocol(scenePlan: string): Promise<string> {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: `You are the Visual Agent, responsible for converting a scene plan into Series protocol instructions.

Your task is to:
1. Analyze the scene plan to understand the visual elements, text, colors, and animations
2. Convert this into a sequence of Series protocol commands
3. Create a visually engaging animation that matches the scene's intent

You are using the Series protocol to instruct the canvas:
- B:color — Set the background color.
- T:id:"text":(x,y):size:color — Draw text.
- X:id — Remove an element.
- A:id:fadeIn:duration=ms - Fade in an element  
- A:id:fadeOut:duration=ms - Fade out an element  
- A:id:pulse:scale=multiplier:duration=ms:repeat=n - Pulse animation  
- A:id:slideIn:from=left|right|top|bottom:distance=px:duration=ms - Slide in from direction  
- A:id:scaleTo:scale=multiplier:duration=ms - Scale element to a new size  
- A:id:rotateTo:degrees=angle:duration=ms - Rotate element  
- A:id:type:interval=ms - Typewriter effect  

### ✅ Guidelines for Text:
- Chunk text into multiple "T:" commands if there are changes in emphasis, tone, pacing, or visual layout
- Use different font weights or styles (italic, bold) for emphasis
- Place text chunks in a **visually stacked or sequenced** layout, not just all in one line
- Use pauses ("W:"), scales ("S:"), or fades ("F:") to animate the rhythm of how the sentence unfolds
- Assign clean and scoped IDs like "S1_text1a", "S1_text1b", etc.
- Ensure strong contrast between background and text
- Match animations to mood: slow fade = reflection, zoom = intensity, delay = hesitation

Guidelines:
- Create a sequence of commands that bring the scene to life
- Use appropriate timing and pacing for animations
- Ensure text is clearly visible and readable
- Use colors that match the scene's mood and theme
- Create smooth transitions between elements
- Output ONLY the Series protocol commands, one per line
- Do not include any explanations or comments
- Give animation duration in milliseconds
- We do not yet support gradients, just set colors such that there is contrast between background and foreground elements such as text
- Do not issue commands to Wait, just use the animation durations to control the timing of the animations
- for "id": use scene_{number}_{chunk_number}_{random 4 character hex}

Visual Design Principles:
- Always maintain strong contrast between background and foreground elements
- Use complementary or contrasting color schemes
- Introduce variation in element colors to enhance visual interest`
            },
            {
              role: 'user',
              content: `Here is the scene plan from the Scene Director:

${scenePlan}

Convert this into a sequence of Series protocol commands that will create a visually engaging animation.`
            }
          ],
          temperature: 0.7,
          max_tokens: 2000
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${errorText}`);
      }

      const data = await response.json() as OpenAIResponse;
      const content = data.choices[0].message.content;
      
      // Return the Series protocol commands
      return content;
    } catch (error) {
      console.error('Error converting to Series protocol:', error);
      throw error;
    }
  }
}
