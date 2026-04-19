interface TTSConfig {
	provider: "elevenlabs" | "system";
	apiKey?: string;
	voiceId?: string;
}

export class TTSEngine {
	private config: TTSConfig;

	constructor(config: TTSConfig) {
		this.config = config;
	}

	async synthesize(text: string): Promise<Buffer> {
		if (this.config.provider === "elevenlabs") {
			if (!this.config.apiKey || !this.config.voiceId) {
				throw new Error("ElevenLabs API key and voiceId are required");
			}

			const response = await fetch(
				`https://api.elevenlabs.io/v1/text-to-speech/${this.config.voiceId}`,
				{
					method: "POST",
					headers: {
						Accept: "audio/mpeg",
						"xi-api-key": this.config.apiKey,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						text,
						model_id: "eleven_monolingual_v1",
						voice_settings: {
							stability: 0.5,
							similarity_boost: 0.5,
						},
					}),
				},
			);

			if (!response.ok) {
				throw new Error(`ElevenLabs API error: ${response.statusText}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			return Buffer.from(arrayBuffer);
		}
		// System TTS placeholder - cross-platform system TTS audio capture is complex
		return Buffer.alloc(0);
	}
}
