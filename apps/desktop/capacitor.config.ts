import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.luminary.torrentcinema',
  appName: 'Luminary',
  webDir: 'dist',
  server: {
    // Dev: подключаемся к Vite dev server (adb reverse tcp:5173)
    // Production: локальный bundled index.html
    androidScheme: 'https',
  },
  plugins: {
    App: { launchAutoHide: false },
    SplashScreen: { launchAutoHide: true, backgroundColor: '#0A0B0E', showSpinner: false },
    Keyboard: { resize: 'body', style: 'dark' },
  },
  android: {
    //.allowMixedContent: true, // HTTP для TorrServer localhost
  },
};

export default config;
