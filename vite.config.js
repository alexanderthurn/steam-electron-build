import { defineConfig } from 'vite';

export default defineConfig({
    // Relative paths so the build works from file:// inside Electron.
    base: './',
    build: {
        target: 'esnext',
    },
});
