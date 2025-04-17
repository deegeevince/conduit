import express, { Request, Response, RequestHandler } from 'express'
import dotenv from 'dotenv';
import { PrincipalDirector } from './principalDirector.js';
import { SceneDirector } from './sceneDirector.js';
import { Agent } from './agent.js';
import path from 'path'
import { fileURLToPath } from 'url'

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
    if (true) {
      await getResponse(req, res);
    } else {
      const response = `B:#00008B
T:1a1b:"It’s easy to laugh it off":(960,540):24:#F5F5F5
A:1a1b:fadeIn:duration=1000
A:1a1b:fadeOut:duration=500:delay=5000
T:1a2b:"or tell yourself it’s not a big deal.":(960,540):24:#F5F5F5
A:1a2b:fadeIn:duration=1000:delay=2000
B:#808080:delay=6000:duration=1000
B:00008B
T:1a3f:"But the truth is,":(960,540):36:#F8F8FF
A:1a3f:fadeIn:duration=1000
A:1a3f:fadeOut:duration=500
T:1b4e:"you knew":(960,600):28:#F8F8FF
A:1b4e:fadeIn:duration=500
B:00008B  
T:1a:"You knew early on":(640,360):48:#F5F5F5  
A:1a:fadeIn:duration=1500  
T:1b:"that it wasn’t right,":(640,420):48:#F5F5F5  
A:1b:fadeIn:duration=1500  
B:D3D3D3  
A:1a:fadeOut:duration=1000  
A:1b:fadeOut:duration=1000
B:00008B
B:0000CD
T:1a1f:"and still, you stayed quiet":(960,540):24:D8D8D8
A:1a1f:fadeIn:duration=2000
A:1a1f:fadeOut:duration=1000
T:2b3e:"— not because you were trying to protect their feelings":(960,590):20:808080
A:2b3e:fadeIn:duration=1500
T:3c4d:"or because you didn’t want to be rude,":(960,640):20:808080
A:3c4d:fadeIn:duration=1500
B:000000:duration=1000
B:#000066
T:1a1a:"but because you didn’t want to sit in the discomfort":(960,540):36:#FFFFFF
A:1a1a:fadeIn:duration=1500
T:1a1b:"of interrupting the moment.":(960,590):36:#FFFFFF
A:1a1b:fadeIn:duration=1500
A:1a1a:fadeOut:duration=1000
A:1a1b:fadeOut:duration=1000
      `
      
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
