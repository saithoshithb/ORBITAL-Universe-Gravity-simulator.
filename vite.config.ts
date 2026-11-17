import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// relative base: the built site works from any sub-path, such as https://<user>.github.io/<repo>/
export default defineConfig({ base: './', plugins: [react()] });
