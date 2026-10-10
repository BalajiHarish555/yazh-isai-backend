import { Injectable } from '@nestjs/common';
import { AIProvider } from './interfaces/ai-provider.interface';
import { OpenRouterProvider } from './providers/openrouter.provider';

@Injectable()
export class AIService {
  private provider: AIProvider;

  constructor() {
    // Strategy pattern: can be switched via config/env
    this.provider = new OpenRouterProvider();
  }

  async interpretIntent(prompt: string) {
    return this.provider.generateStructuredOutput<{
      moods: string[];
      energy: string;
      activity?: string;
      time?: string;
    }>(
      { prompt },
      {} // Schema would be passed here in real implementation
    );
  }

  async generatePlaylistConcept(prompt: string) {
    return this.provider.generateStructuredOutput<{
      title: string;
      description: string;
      suggestedMoods: string[];
    }>(
      { 
        prompt, 
        systemPrompt: 'You are a cinematic music curator. Generate a playlist concept.' 
      },
      {}
    );
  }
}
