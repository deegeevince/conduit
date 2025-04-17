import dotenv from 'dotenv';

dotenv.config();

interface ScenePlan {
  sceneIndex: number;
  sceneTitle: string;
  text: string;
  font: string;
  position: string;
  color: string;
  background: string;
  animation: string;
  duration: string;
  transition: string;
}

/**
 * Scene Director - Translates a single scene from the Principal Director's vision
 * into a detailed visual plan, expressed in natural language.
 */
export class SceneDirector {
  private apiKey: string;
  private model: string = 'gpt-4-turbo';

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }
  }

  /**
   * Process the Principal Director's output and focus on a specific scene
   * @param principalDirectorOutput The full output from the Principal Director
   * @param sceneIdentifier The target scene index or label (e.g. "Scene 2" or "Scene 2 – You Already Knew")
   * @returns A detailed visual plan for the specified scene
   */
  async processScene(principalDirectorOutput: string, sceneIdentifier: string): Promise<string> {
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
              content: `You are the Scene Director, responsible for turning a single scene from the Principal Director’s vision into a detailed, expressive visual plan.

Your job is to:
- Focus only on the specific scene assigned to you
- Stay aware of the visual identity and tone of the overall work
- Break the scene’s sentence into visual chunks or phrases
- Provide detailed natural language instructions describing how each chunk should appear on screen

Your output must:
- Begin with the scene title and the full original text
- Then describe the visual plan in clearly structured natural language
- Specify the background design and emotional tone
- For each chunk of text:
  - Write the exact phrase
  - Describe where it should appear on screen (position) in x, y co-ordinates as pixels
  - Define the typography: font family, size, weight, and style
  - Specify foreground color
  - Explain the entry animation (e.g. fade in, fade out, pulse, slide in, scale to, rotate to, type write it out), including duration and any delay
  - Describe the exit animation, if any
- Finally, state the total scene duration and describe how the scene should transition into the next
- Calculate the total scene duration based on the sum of all chunk timings, unless overlapping.

Guidelines:
- Do not write in JSON or code
- Use natural language, but be precise and structured
- Use hex values for colors where possible
- Use milliseconds for all durations
- Chunk the text to match emotional rhythm or narrative emphasis
- Ensure clear contrast between foreground and background
- Do not include explanations of your reasoning — just the visual plan

Your output must look like this:

---

Scene Title: [Insert Scene Title]  
Scene Text: "[Full scene sentence]"

Visual Plan:

[Describe the background styling — solid color or gradient, with color codes.]

[Describe Chunk 1]
- ...

[Describe Chunk 2]
- ...


---

Now, take the following scene and create a complete visual plan.`
            },
            {
              role: 'user',
              content: `Here is the full output from the Principal Director:

${principalDirectorOutput}

Please focus ONLY on this specific scene: ${sceneIdentifier}

Create a detailed visual plan for this scene, following the format specified.`
            }
          ],
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices[0].message.content;
      console.log('Scene Director output:', content);
      
      return content;
    } catch (error) {
      console.error('Error processing scene:', error);
      throw error;
    }
  }
} 