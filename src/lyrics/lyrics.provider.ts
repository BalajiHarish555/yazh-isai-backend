export interface LyricsProvider {
  readonly name: string;

  isAvailable(): Promise<boolean>;

  fetchLyrics(artist: string, track: string): Promise<string | null>;
}