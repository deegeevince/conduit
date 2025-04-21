import express, { Request, Response, RequestHandler } from 'express'
import dotenv from 'dotenv';
import { PrincipalDirector } from './principalDirector.js';
import { SceneDirector } from './sceneDirector.js';
import { Agent } from './agent.js';
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs';



// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Get directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../../public')));


async function getOpenAIResponse(req: Request, res: Response) {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt in request body' });
  }

  console.log('Received prompt:', prompt);

  // Read instruction set
  const instructionSet = fs.readFileSync(path.join(__dirname, '../../src/instructionset.txt'), 'utf8');

  try {
    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();


    // console.log(instructionSet);
    // console.log(prompt);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: instructionSet
          },
          {
            role: 'user', 
            content: prompt
          }
        ],
        stream: true
      })
    });

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let commandBuffer = '';

    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        // console.log(line);
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            
            if (content) {
              commandBuffer += content;

              let newlineIndex;
              while ((newlineIndex = commandBuffer.indexOf('\n')) >= 0) {
                const line = commandBuffer.slice(0, newlineIndex).trim();
                console.log(line);
                commandBuffer = commandBuffer.slice(newlineIndex + 1);

                if (line.length > 0) {
                  res.write(`data: ${line}\n\n`);
                }
              }
            }
          } catch (e) {
            console.error('Error parsing JSON:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
    res.write('data: Error processing request\n\n');
  }
}


async function getResponse(req: Request, res: Response) {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt in request body' });
  }

  console.log('Received prompt:', prompt);

  // Initialize directors
  const principalDirector = new PrincipalDirector();
  const sceneDirector = new SceneDirector();
  const agent = new Agent();

  // Process the input with Principal Director
  console.log('Processing input with Principal Director...');
  const principalOutput = await principalDirector.processInput(prompt);
  console.log(principalOutput);

  // Extract scene identifiers
  const sceneIdentifiers = principalDirector.extractSceneIdentifiers(principalOutput);
  console.log(`Found ${sceneIdentifiers.length} scenes`);

  // Set headers for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Process each scene with Scene Director and Agent
  for (const sceneId of sceneIdentifiers) {
    console.log(`Processing ${sceneId}...`);

    const scenePlan = await sceneDirector.processScene(principalOutput, sceneId);
    const seriesCommands = await agent.convertToSeriesProtocol(scenePlan);
    console.log(seriesCommands);
    const lines = seriesCommands.trim().split('\n');
    for (const line of lines) {
      res.write(`data: ${line}\n\n`);
    }
  }
}

// Stream endpoint
app.post('/stream', (async (req, res) => {
  try {
    if (false) {
      await getResponse(req, res);
    } else if (true) {
      await getOpenAIResponse(req, res);
    } else {
      console.log(path.join(__dirname, '../animations.txt'))
      const response = fs.readFileSync(path.join(__dirname, '../../src/animations.txt'), 'utf8');

      const lines = response.trim().split('\n');
      for (const line of lines) {
        res.write(`data: ${line}\n\n`);
      }
    }



    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Error processing stream:', error);
    res.write('data: ERROR\n\n');
    res.end();
  }
}) as RequestHandler);

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

/**
 * Main entry point for the application
 */
async function main() {
  try {
    // Check if OpenAI API key is available
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    const principalDirector = new PrincipalDirector();
    const sceneDirector = new SceneDirector();
    const agent = new Agent();

    const userInput = `You ever sit through a haircut, quietly dreading every second of it?
In fact, even early on, you already knew.`;

    // Process the input with Principal Director
    console.log('Processing input with Principal Director...');
    const principalOutput = await principalDirector.processInput(userInput);
    console.log('Principal Director output:');
    console.log(principalOutput);

    const sceneIdentifiers = principalDirector.extractSceneIdentifiers(principalOutput);
    console.log(`Found ${sceneIdentifiers.length} scenes:`, sceneIdentifiers);

    console.log('\nProcessing scenes with Scene Director and Agent...');
    for (const sceneId of sceneIdentifiers) {
      console.log(`\nProcessing ${sceneId}...`);

      const scenePlan = await sceneDirector.processScene(principalOutput, sceneId);
      console.log(`\nConverting scene plan to Series protocol commands...`);
      const seriesCommands = await agent.convertToSeriesProtocol(scenePlan);
      console.log(`Series protocol commands for ${sceneId}:`);
      console.log(seriesCommands);
    }
  } catch (error) {
    console.error('Error in main:', error);
    process.exit(1);
  }
}
