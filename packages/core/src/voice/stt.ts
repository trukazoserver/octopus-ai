interface STTConfig {
  provider: "whisper";
  apiKey?: string;
}

export class STTEngine {
  private config: STTConfig;

  constructor(config: STTConfig) {
    this.config = config;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    if (this.config.provider === "whisper") {
      if (!this.config.apiKey) {
        throw new Error("Whisper API key is required");
      }

      let filename = "audio.wav";
      if (mimeType.includes("mp3")) filename = "audio.mp3";
      else if (mimeType.includes("webm")) filename = "audio.webm";
      else if (mimeType.includes("mp4")) filename = "audio.mp4";

      const blob = new Blob([audio], { type: mimeType });
      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("model", "whisper-1");

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as { text: string };
      return data.text;
    }

    throw new Error(`Unsupported STT provider: ${this.config.provider}`);
  }
}
