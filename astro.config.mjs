// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: "https://rboud.com",
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'fr',
  }
});
