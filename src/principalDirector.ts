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

export interface ScenePlan {
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

export interface CreativeResult {
  creativeIntent: string;
  visualIdentity: string;
  scenes: ScenePlan[];
}

/**
 * Principal Director - Interprets user input and generates a complete creative vision
 * broken down into scenes with detailed visual and animation instructions.
 */
export class PrincipalDirector {
  private apiKey: string;
  private model: string = 'gpt-4-turbo';

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required');
    }
  }

  /**
   * Process user input and generate a complete creative vision
   * @param userInput The user's text input
   * @returns A structured response with creative intent, visual identity, and scenes
   */
  async processInput(userInput: string): Promise<string> {
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
              content: `You are the Principal Director, an LLM agent responsible for interpreting user input and generating a complete creative vision broken down into scenes.

Your task is to:
1. Interpret the user's intent, identifying emotional/narrative arcs, tone, pacing, and mood
2. Break the input into 1-6 discrete scenes based on meaning or emotional shifts
3. For each scene, provide detailed visual and animation instructions
4. Set global design direction for all scenes

Output your response in the following format:

[Creative Intent]
A short paragraph describing the overall experience, emotional arc, and visual theme.

[Visual Identity]
- Typography: [font family, weights, sizes]
- Colors: [primary, secondary, accent colors]
- Layout: [centered, vertical offset, etc.]
- Animation: [fade, scale, slide, etc.]

[Scene 1 – "Scene Title"]
"Exact sentence from user input."
Describe visual tone, text style, animation behavior, layout, and timing.

[Scene 2 – "Scene Title"]
"Next sentence or phrase."
Continue as above...

Be creative, thoughtful, and ensure your instructions are clear and actionable.`
            },
            {
              role: 'user',
              content: userInput
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
      // console.log('content', content);
      
      // Return the raw content
      return content;
    } catch (error) {
      console.error('Error processing input:', error);
      throw error;
    }
  }

  /**
   * Extract scene identifiers from the Principal Director's output
   * @param output The output from PrincipalDirector.processInput
   * @returns Array of scene identifiers (e.g., "Scene 1", "Scene 2 – Title")
   */
  extractSceneIdentifiers(output: string): string[] {
    const sceneRegex = /\[Scene \d+[^\]]*\]/g;
    const matches = output.match(sceneRegex) || [];
    return matches.map(match => match.slice(1, -1)); // Remove the brackets
  }
}