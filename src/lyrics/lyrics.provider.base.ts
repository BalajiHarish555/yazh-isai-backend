import { Injectable } from '@nestjs/common';
import { LyricsProvider } from './lyrics.provider';

export abstract class BaseLyricsProvider implements LyricsProvider {
  protected abstract readonly providerName: string;
  
  get name(): string {
    return this.providerName;
  }

  abstract isAvailable(): Promise<boolean>;
  
  abstract fetchLyrics(artist: string, track: string): Promise<string | null>;
}