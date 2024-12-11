const supportedLanguages = ["fr", "en"] as const;

type SupportedLanguages = typeof supportedLanguages[number];
