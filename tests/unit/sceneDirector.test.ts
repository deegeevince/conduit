// import { SceneDirector } from '../../src/sceneDirector.js';
// import { PrincipalDirector } from '../../src/principalDirector.js';
// import dotenv from 'dotenv';
// import { jest } from '@jest/globals';

// // Load environment variables
// dotenv.config();

// describe('SceneDirector', () => {
//   let principalDirector: PrincipalDirector;
//   let sceneDirector: SceneDirector;
//   let samplePrincipalDirectorOutput: string;

//   beforeAll(async () => {
//     // Ensure API key is available
//     if (!process.env.OPENAI_API_KEY) {
//       throw new Error('OPENAI_API_KEY environment variable is required for tests');
//     }
    
//     principalDirector = new PrincipalDirector();
//     sceneDirector = new SceneDirector();
    
//     // Get a sample output from the Principal Director
//     const input = "The journey begins with uncertainty. With each step, confidence grows. Finally, we emerge into a world of endless possibilities.";
//     samplePrincipalDirectorOutput = await principalDirector.processInput(input);
//   }, 30000);

//   describe('extractScene', () => {
//     it('should extract a specific scene from the Principal Director output', () => {
//       const sceneIndex = 1;
//       const extractedScene = sceneDirector.extractScene(samplePrincipalDirectorOutput, sceneIndex);
      
//       expect(extractedScene).not.toBeNull();
//       expect(extractedScene).toContain(`[Scene ${sceneIndex}`);
//       expect(extractedScene).toContain('"');
//     });
    
//     it('should return null for a non-existent scene', () => {
//       const sceneIndex = 999; // Assuming this scene doesn't exist
//       const extractedScene = sceneDirector.extractScene(samplePrincipalDirectorOutput, sceneIndex);
      
//       expect(extractedScene).toBeNull();
//     });
//   });

//   describe('processScene', () => {
//     it('should process a specific scene and return a detailed visual plan', async () => {
//       const sceneIdentifier = "Scene 1";
      
//       const visualPlan = await sceneDirector.processScene(samplePrincipalDirectorOutput, sceneIdentifier);
      
//       // Verify the output contains the expected sections
//       expect(visualPlan).toContain('[Scene');
//       expect(visualPlan).toContain('Text:');
//       expect(visualPlan).toContain('Visual Plan:');
//       expect(visualPlan).toContain('- Font:');
//       expect(visualPlan).toContain('- Position:');
//       expect(visualPlan).toContain('- Color:');
//       expect(visualPlan).toContain('- Background:');
//       expect(visualPlan).toContain('- Animation:');
//       expect(visualPlan).toContain('- Duration:');
//       expect(visualPlan).toContain('- Transition:');
//     }, 30000);
    
//     it('should handle scene identifiers with titles', async () => {
//       // Extract the first scene to get its title
//       const firstScene = sceneDirector.extractScene(samplePrincipalDirectorOutput, 1);
//       const titleMatch = firstScene?.match(/\[Scene \d+ – "([^"]+)"\]/);
//       const sceneTitle = titleMatch ? titleMatch[1] : '';
      
//       const sceneIdentifier = `Scene 1 – "${sceneTitle}"`;
      
//       const visualPlan = await sceneDirector.processScene(samplePrincipalDirectorOutput, sceneIdentifier);
      
//       // Verify the output contains the scene title
//       expect(visualPlan).toContain(sceneTitle);
//     }, 30000);
//   });
// }); 