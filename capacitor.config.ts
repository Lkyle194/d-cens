import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fr.lkyle.dcens',
  appName: 'D-Cens',
  webDir: 'dist/d-cens/browser',
  server: {
    // Les headers COOP/COEP sont requis en production Web (Vercel).
    // Sur Android, WebView les applique via le manifest — on les laisse ici
    // pour la synchronisation locale du dossier dist.
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0b0e14'
  }
};

export default config;
