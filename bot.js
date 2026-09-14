// bot.js
// Entrypoint alternativo: solo inicia el bot (para correr como Worker en Render)
import { initDatabase } from './database.js';
import { startTelegramBot } from './services/telegramBot.js';

(async () => {
  try {
    await initDatabase();
    console.log('🤖 Iniciando bot como worker independiente...');
    await startTelegramBot();
  } catch (err) {
    console.error('❌ Error fatal en el bot:', err);
    process.exit(1);
  }
})();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));