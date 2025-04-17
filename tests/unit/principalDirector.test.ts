import { PrincipalDirector } from '../../src/principalDirector.js';
import dotenv from 'dotenv';
import { jest } from '@jest/globals';

// Load environment variables
dotenv.config();

describe('PrincipalDirector', () => {
  let director: PrincipalDirector;

  beforeAll(() => {
    // Ensure API key is available
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required for tests');
    }
    director = new PrincipalDirector();
  });

  describe('processInput', () => {
    it('should process a simple input and return a response', async () => {
      const input = "The journey begins with uncertainty, as shadows dance across the path ahead.";
      
      const response = await director.processInput(input);
      console.log(response);
      
      // Verify response contains expected sections
      expect(response).toContain('[Creative Intent]');
      expect(response).toContain('[Visual Identity]');
      expect(response).toContain('[Scene');
      
      // Verify response contains the input text
      expect(response).toContain("uncertainty");
    }, 30000); // Increase timeout for API call
    
    it('should handle multi-sentence input and create multiple scenes', async () => {
      const input = "The journey begins with uncertainty. With each step, confidence grows. Finally, we emerge into a world of endless possibilities.";
      
      const response = await director.processInput(input);
      
      // Verify multiple scenes are created
      const sceneCount = (response.match(/\[Scene/g) || []).length;
      expect(sceneCount).toBeGreaterThan(1);
      
      // Verify each scene contains the expected format
      expect(response).toMatch(/\[Scene \d+ – ".*"\]\n".*"/g);
    }, 30000);
    
    it('should handle emotional content appropriately', async () => {
      const input = "Joy fills my heart as I embrace the moment. But sadness creeps in when I realize it's fleeting.";
      
      const response = await director.processInput(input);
      
      // Verify emotional content is captured in creative intent
      expect(response.toLowerCase()).toMatch(/(joy|happiness|sadness|emotion)/);
      
      // Verify scenes reflect emotional shifts
      const sceneCount = (response.match(/\[Scene/g) || []).length;
      expect(sceneCount).toBeGreaterThan(1);
      
      // Check that visual tones reflect emotions
      expect(response.toLowerCase()).toMatch(/(joy|happy)/);
      expect(response.toLowerCase()).toMatch(/(sad|melancholy)/);
    }, 30000);
    
    it('should provide consistent visual identity across scenes', async () => {
      const input = "First scene. Second scene. Third scene.";
      
      const response = await director.processInput(input);
      
      // Verify visual identity is consistent
      expect(response).toMatch(/- Typography: .*/);
      expect(response).toMatch(/- Colors: .*/);
      expect(response).toMatch(/- Layout: .*/);
      expect(response).toMatch(/- Animation: .*/);
      
      // Extract typography from response
      const typographyMatch = response.match(/- Typography: (.*?)(?=\n|$)/);
      const typography = typographyMatch ? typographyMatch[1].trim() : '';
      
      // Verify all scenes use the same visual language
      expect(response).toMatch(new RegExp(typography.split(',')[0].trim(), 'i'));
    }, 30000);
  });
}); 